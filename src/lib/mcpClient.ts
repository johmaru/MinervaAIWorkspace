import type OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { logger } from "@/lib/logger";

/**
 * Allowed binaries for MCP stdio transport.
 * Excludes: docker (host escape), env (command passthrough),
 * sh/bash/cmd (shell injection), curl/wget/nc (network tools).
 */
const ALLOWED_MCP_BINARIES = new Set([
  "npx", "node", "python", "python3", "uvx", "bun",
]);

/**
 * Flags that enable code execution — always blocked in MCP args.
 */
const BLOCKED_MCP_FLAGS = new Set([
  "-e", "--eval",
  "-c",
  "-i", "--interactive",
  "--exec",
]);

/**
 * Validate an MCP stdio command and its args.
 * @returns { allowed: boolean, reason?: string }
 */
export function validateMcpStdioCommand(
  command: string,
  args: string[],
): { allowed: boolean; reason?: string } {
  // Extract binary name from path
  const parts = command.split(/[/\\]/);
  const binaryName = (parts[parts.length - 1] || "").replace(/\.exe$/i, "").toLowerCase();

  if (!binaryName) {
    return { allowed: false, reason: "empty command" };
  }

  if (!ALLOWED_MCP_BINARIES.has(binaryName)) {
    return { allowed: false, reason: `binary "${binaryName}" is not in the allowed list` };
  }

  for (const arg of args) {
    const flag = arg.toLowerCase();
    if (BLOCKED_MCP_FLAGS.has(flag)) {
      return { allowed: false, reason: `flag "${arg}" is blocked (code execution)` };
    }
  }

  return { allowed: true };
}

/**
 * Normalized shape of MCP server config.
 * Compatible with DB mcpServers rows (has id/name/transport/url/command/args/env).
 */
export type McpServerConfig = {
  id: string;
  name: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[] | null;
  env: Record<string, string> | null;
};

/**
 * Internal representation of an MCP tool. Tagged with serverId/serverName so
 * the connection can be reverse-looked-up during tool_call dispatch.
 */
export type McpTool = {
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/**
 * An established MCP connection. Held for the same lifecycle as streaming.
 */
export type McpConnection = {
  client: Client;
  serverId: string;
  serverName: string;
};

/** Separator to prevent tool name collisions. Built-in tools (e.g. scrape_webpage) do not contain __. */
export const MCP_NAME_SEPARATOR = "__";

/**
 * Generates a function name for the OpenAI tools array from an MCP tool name.
 * Format: "{serverName}__{toolName}". If serverName contains __, it is split at the first __.
 */
export function mcpToolFunctionName(serverName: string, toolName: string): string {
  return `${serverName}${MCP_NAME_SEPARATOR}${toolName}`;
}

/**
 * Splits an OpenAI tools array function name into (serverName, toolName).
 * Splits at the first __; the remainder is the toolName (toolName may contain __).
 */
export function parseMcpToolFunctionName(
  name: string,
): { serverName: string; toolName: string } | null {
  const idx = name.indexOf(MCP_NAME_SEPARATOR);
  if (idx === -1) return null;
  return {
    serverName: name.slice(0, idx),
    toolName: name.slice(idx + MCP_NAME_SEPARATOR.length),
  };
}

/**
 * Connects to a single MCP server.
 * transport="http": tries Streamable HTTP, falls back to SSE on failure.
 * transport="stdio": spawns a child process.
 * Returns null on connection failure; the caller skips it.
 */
export async function connectMcpServer(
  config: McpServerConfig,
): Promise<McpConnection | null> {
  const client = new Client(
    { name: "umanschat-mcp-client", version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    if (config.transport === "http") {
      if (!config.url) {
        logger.error("mcp", "http server has no url, skipping", { server: config.name });
        return null;
      }
      const url = new URL(config.url);
      // Prefer Streamable HTTP. Servers supporting only legacy SSE are handled via fallback.
      try {
        const transport = new StreamableHTTPClientTransport(url);
        await client.connect(transport);
      } catch (httpErr) {
        logger.warn("mcp", "StreamableHTTP failed, falling back to SSE", { server: config.name, error: httpErr instanceof Error ? httpErr.message : String(httpErr) });
        const sseTransport = new SSEClientTransport(url);
        await client.connect(sseTransport);
      }
    } else if (config.transport === "stdio") {
      if (!config.command) {
        logger.error("mcp", "stdio server has no command, skipping", { server: config.name });
        return null;
      }
      const stdioArgs = config.args ?? [];
      const validation = validateMcpStdioCommand(config.command, stdioArgs);
      if (!validation.allowed) {
        logger.error("mcp", "stdio command blocked", { server: config.name, reason: validation.reason });
        return null;
      }
      // Minimal env: no secrets leaked to MCP child process
      const safeEnv: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        USERPROFILE: process.env.USERPROFILE ?? "",
        LANG: process.env.LANG ?? "en_US.UTF-8",
      };
      const transport = new StdioClientTransport({
        command: config.command,
        args: stdioArgs,
        env: { ...safeEnv, ...(config.env ?? {}) },
      });
      await client.connect(transport);
    } else {
      logger.error("mcp", "unknown transport", { transport: config.transport, server: config.name });
      return null;
    }
    logger.info("mcp", "connected", { server: config.name, transport: config.transport });
    return { client, serverId: config.id, serverName: config.name };
  } catch (err) {
    logger.error("mcp", "connection failed", { server: config.name, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Gets the tool list from a connected MCP server.
 * Returns an empty array on failure; does not block tool retrieval from other servers.
 */
export async function listMcpTools(conn: McpConnection): Promise<McpTool[]> {
  try {
    const result = await conn.client.listTools();
    return (result.tools ?? []).map((tool) => ({
      serverId: conn.serverId,
      serverName: conn.serverName,
      toolName: tool.name,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    }));
  } catch (err) {
    logger.error("mcp", "listTools failed", { server: conn.serverName, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * Calls a tool on an MCP server and returns text content.
 * Joins entries from the content array where type==="text". Falls back to JSON if no text.
 */
export async function callMcpTool(
  conn: McpConnection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const result = await conn.client.callTool({ name: toolName, arguments: args });
    const content = result.content;
    if (Array.isArray(content)) {
      const texts = content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text);
      if (texts.length > 0) return texts.join("\n");
    }
    return JSON.stringify(content);
  } catch (err) {
    return `Error calling ${toolName}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Converts an MCP tool array to OpenAI ChatCompletionTool format.
 * Function names are "{serverName}__{toolName}" to avoid collisions with built-in tools.
 */
export function mcpToolsToOpenAIFormat(
  tools: McpTool[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: mcpToolFunctionName(tool.serverName, tool.toolName),
      description: tool.description || `${tool.serverName}/${tool.toolName}`,
      parameters: tool.inputSchema,
    },
  }));
}
