import type OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * MCP サーバー設定の正規化された形状。
 * DB の mcpServers 行と互換（id/name/transport/url/command/args/env を持つ）。
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
 * MCP ツールの内部表現。serverId/serverName を付与して
 * tool_call のディスパッチ時に接続を逆引きできるようにする。
 */
export type McpTool = {
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/**
 * 確立済みの MCP 接続。ストリーミング完了まで同一ライフサイクルで保持。
 */
export type McpConnection = {
  client: Client;
  serverId: string;
  serverName: string;
};

/** ツール名の衝突を防ぐためのセパレータ。組み込みツール (scrape_webpage 等) は __ を含まない。 */
export const MCP_NAME_SEPARATOR = "__";

/**
 * MCP ツール名 → OpenAI tools 配列用の関数名を生成。
 * 形式: "{serverName}__{toolName}"。serverName に __ が含まれる場合は最初の __ で分割される。
 */
export function mcpToolFunctionName(serverName: string, toolName: string): string {
  return `${serverName}${MCP_NAME_SEPARATOR}${toolName}`;
}

/**
 * OpenAI tools 配列の関数名 → (serverName, toolName) に分割。
 * 最初の __ で分割し、残りを toolName とする（toolName に __ が含まれていても可）。
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
 * 1つの MCP サーバーに接続する。
 * transport="http": Streamable HTTP を試行し、失敗時に SSE にフォールバック。
 * transport="stdio": 子プロセスを起動。
 * 接続失敗時は null を返し、呼び出し元はスキップする。
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
        console.error(`[mcp] http server "${config.name}" has no url — skipping`);
        return null;
      }
      const url = new URL(config.url);
      // Streamable HTTP を優先。旧式 SSE のみのサーバーはフォールバックで対応。
      try {
        const transport = new StreamableHTTPClientTransport(url);
        await client.connect(transport);
      } catch (httpErr) {
        console.warn(
          `[mcp] StreamableHTTP failed for "${config.name}", falling back to SSE:`,
          httpErr instanceof Error ? httpErr.message : httpErr,
        );
        const sseTransport = new SSEClientTransport(url);
        await client.connect(sseTransport);
      }
    } else if (config.transport === "stdio") {
      if (!config.command) {
        console.error(`[mcp] stdio server "${config.name}" has no command — skipping`);
        return null;
      }
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env ?? undefined,
      });
      await client.connect(transport);
    } else {
      console.error(`[mcp] unknown transport "${config.transport}" for "${config.name}"`);
      return null;
    }
    console.log(`[mcp] connected to ${config.name} (${config.transport})`);
    return { client, serverId: config.id, serverName: config.name };
  } catch (err) {
    console.error(
      `[mcp] connection failed for ${config.name}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * 接続済み MCP サーバーのツール一覧を取得。
 * 失敗時は空配列を返し、他のサーバーのツール取得は阻害しない。
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
    console.error(
      `[mcp] listTools failed for ${conn.serverName}:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * MCP サーバーのツールを呼び出し、テキストコンテンツを返す。
 * content 配列から type==="text" のものを結合。テキストが無ければ JSON でフォールバック。
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
 * MCP ツール配列を OpenAI ChatCompletionTool 形式に変換。
 * 関数名は "{serverName}__{toolName}" とし、組み込みツールとの衝突を回避。
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
