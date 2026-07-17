import type OpenAI from "openai";
import { db } from "@/db";
import { connections } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { callNotionApi } from "./notion";
import { GITHUB_TOOLS, dispatchGithubTool } from "./github";
import { GMAIL_TOOLS, dispatchGmailTool } from "./gmail";
import { GDRIVE_TOOLS, dispatchGdriveTool } from "./google-drive";
import { GCAL_TOOLS, dispatchGcalTool } from "./google-calendar";

/**
 * Connection management module.
 *
 * - loadConnections: loads the user's active connection rows
 * - getConnectionTools: returns OpenAI tool definitions provided by the connection
 * - dispatchConnectionTool: dispatches tool calls to the corresponding provider API
 *
 * When adding a new provider:
 * 1. Add a provider branch to getConnectionTools
 * 2. Add a provider branch to dispatchConnectionTool
 * 3. Use a tool name prefix (notion_, google_, github_) to avoid collisions
 */

export type { ConnectionRow, DispatchResult } from "./types";
import type { ConnectionRow, DispatchResult } from "./types";
export type { ProviderId } from "./provider-map";
export { resolveProviderFromToolName } from "./provider-map";

/**
 * Loads the connection rows corresponding to the given connection IDs.
 */
export async function loadConnections(
  userId: string,
  connectionIds: string[],
): Promise<ConnectionRow[]> {
  if (connectionIds.length === 0) return [];
  return db
    .select({
      id: connections.id,
      provider: connections.provider,
      accessToken: connections.accessToken,
      refreshToken: connections.refreshToken,
      scopes: connections.scopes,
      expiresAt: connections.expiresAt,
      workspaceName: connections.workspaceName,
    })
    .from(connections)
    .where(and(eq(connections.userId, userId), inArray(connections.id, connectionIds)));
}

/**
 * Returns the tool definitions provided by the connection in OpenAI ChatCompletionTool format.
 * Each provider exposes a different tool set.
 */
export function getConnectionTools(
  conn: ConnectionRow,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  switch (conn.provider) {
    case "notion":
      return NOTION_TOOLS;
    case "github":
      return GITHUB_TOOLS;
    case "gmail":
      return GMAIL_TOOLS;
    case "google_drive":
      return GDRIVE_TOOLS;
    case "google_calendar":
      return GCAL_TOOLS;
    default:
      return [];
  }
}

const NOTION_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "notion_search",
      description:
        "Search pages and databases in the user's Notion workspace by title. Use when the user asks to find or search Notion content.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query to match against page/database titles",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "notion_get_page",
      description: "Get a specific Notion page's properties and metadata by its ID.",
      parameters: {
        type: "object",
        properties: {
          page_id: {
            type: "string",
            description: "The UUID of the Notion page",
          },
        },
        required: ["page_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "notion_get_blocks",
      description:
        "Get the content blocks of a Notion page (its children). Use to read the actual text content of a page.",
      parameters: {
        type: "object",
        properties: {
          block_id: {
            type: "string",
            description: "The UUID of the Notion page or block to read children of",
          },
        },
        required: ["block_id"],
      },
    },
  },
];

/**
 * Dispatches a tool call to the corresponding connection API.
 * Returns text content + refreshed tokens (if any).
 */
export async function dispatchConnectionTool(
  conn: ConnectionRow,
  toolName: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  switch (conn.provider) {
    case "notion":
      return dispatchNotionTool(conn, toolName, args);
    case "github":
      return dispatchGithubTool(conn, toolName, args);
    case "gmail":
      return dispatchGmailTool(conn, toolName, args);
    case "google_drive":
      return dispatchGdriveTool(conn, toolName, args);
    case "google_calendar":
      return dispatchGcalTool(conn, toolName, args);
    default:
      return { content: `Unknown provider: ${conn.provider}` };
  }
}

async function dispatchNotionTool(
  conn: ConnectionRow,
  toolName: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  if (toolName === "notion_search") {
    const query = String(args.query ?? "");
    const result = await callNotionApi(
      conn.accessToken,
      conn.refreshToken,
      "POST",
      "/v1/search",
      { query, page_size: 10 },
    );
    if (!result.ok) return { content: `Notion search failed: ${result.error}` };
    const data = result.data as { results: Array<Record<string, unknown>> };
    const lines: string[] = [];
    for (const item of data.results ?? []) {
      const id = item.id as string;
      const objectType = item.object as string;
      let title = "";
      // For pages: properties.title.title[].plain_text
      // For databases: title[].plain_text
      const props = item.properties as Record<string, unknown> | undefined;
      if (props?.title) {
        const titleArr = (props.title as { title?: Array<{ plain_text?: string }> }).title;
        title = titleArr?.map((t) => t.plain_text ?? "").join("") ?? "";
      } else if (Array.isArray(item.title)) {
        title = (item.title as Array<{ plain_text?: string }>)
          .map((t) => t.plain_text ?? "")
          .join("");
      }
      lines.push(`- [${objectType}] ${title || "(untitled)"} — id: ${id}`);
    }
    return {
      content: lines.length > 0 ? lines.join("\n") : "No results found.",
      newAccessToken: result.newAccessToken,
      newRefreshToken: result.newRefreshToken,
    };
  }

  if (toolName === "notion_get_page") {
    const pageId = String(args.page_id ?? "");
    const result = await callNotionApi(
      conn.accessToken,
      conn.refreshToken,
      "GET",
      `/v1/pages/${pageId}`,
    );
    if (!result.ok) return { content: `Notion get_page failed: ${result.error}` };
    return {
      content: JSON.stringify(result.data, null, 2),
      newAccessToken: result.newAccessToken,
      newRefreshToken: result.newRefreshToken,
    };
  }

  if (toolName === "notion_get_blocks") {
    const blockId = String(args.block_id ?? "");
    const result = await callNotionApi(
      conn.accessToken,
      conn.refreshToken,
      "GET",
      `/v1/blocks/${blockId}/children?page_size=100`,
    );
    if (!result.ok) return { content: `Notion get_blocks failed: ${result.error}` };
    const data = result.data as { results: Array<Record<string, unknown>> };
    const lines: string[] = [];
    for (const block of data.results ?? []) {
      const type = block.type as string;
      if (!type) continue;
      const blockData = (block as Record<string, unknown>)[type] as
        | { text?: Array<{ plain_text?: string }> }
        | undefined;
      const text = blockData?.text?.map((t) => t.plain_text ?? "").join("") ?? "";
      lines.push(`[${type}] ${text}`);
    }
    return {
      content: lines.length > 0 ? lines.join("\n") : "No content blocks found.",
      newAccessToken: result.newAccessToken,
      newRefreshToken: result.newRefreshToken,
    };
  }

  return { content: `Unknown Notion tool: ${toolName}` };
}
