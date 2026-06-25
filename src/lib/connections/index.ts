import type OpenAI from "openai";
import { db } from "@/db";
import { connections } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { callNotionApi } from "./notion";

/**
 * コネクション管理モジュール。
 *
 * - loadConnections: ユーザーのアクティブなコネクション行をロード
 * - getConnectionTools: コネクションが提供する OpenAI ツール定義を返す
 * - dispatchConnectionTool: ツール呼び出しを対応するプロバイダー API へディスパッチ
 *
 * 新規プロバイダー追加時は:
 * 1. getConnectionTools に provider ブランチを追加
 * 2. dispatchConnectionTool に provider ブランチを追加
 * 3. ツール名プレフィックス (notion_, google_, github_) を使用して衝突を回避
 */

export type ConnectionRow = {
  id: string;
  provider: string;
  accessToken: string;
  refreshToken: string;
  workspaceName: string | null;
};

/**
 * 指定されたコネクションIDに対応するコネクション行をロードする。
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
      workspaceName: connections.workspaceName,
    })
    .from(connections)
    .where(and(eq(connections.userId, userId), inArray(connections.id, connectionIds)));
}

/**
 * コネクションが提供するツール定義を OpenAI ChatCompletionTool 形式で返す。
 * プロバイダーごとに異なるツールセットを公開する。
 */
export function getConnectionTools(
  conn: ConnectionRow,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  if (conn.provider === "notion") {
    return NOTION_TOOLS;
  }
  return [];
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
 * ツール呼び出しを対応するコネクション API へディスパッチする。
 * テキストコンテンツ + リフレッシュされたトークン（あれば）を返す。
 */
export async function dispatchConnectionTool(
  conn: ConnectionRow,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: string; newAccessToken?: string; newRefreshToken?: string }> {
  if (conn.provider === "notion") {
    return dispatchNotionTool(conn, toolName, args);
  }
  return { content: `Unknown provider: ${conn.provider}` };
}

async function dispatchNotionTool(
  conn: ConnectionRow,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: string; newAccessToken?: string; newRefreshToken?: string }> {
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
      // ページの場合: properties.title.title[].plain_text
      // データベースの場合: title[].plain_text
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
