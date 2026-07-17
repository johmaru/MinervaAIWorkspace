/**
 * Outlook Mail OAuth Connection provider.
 *
 * Uses the shared microsoft-oauth.ts helper for token exchange/refresh.
 *
 * Verified endpoints (2026-07-17, learn.microsoft.com):
 * - List messages:  GET /me/messages?$search="query" (KQL syntax; no ConsistencyLevel needed)
 * - Get message:    GET /me/messages/{id}
 * - List folders:   GET /me/mailFolders
 *
 * Scopes: offline_access User.Read Mail.Read
 */

import type { ConnectionRow, DispatchResult } from "./types";
import {
  buildMicrosoftAuthorizeUrl,
  callMicrosoftApi,
  exchangeMicrosoftCode,
  expiryFromExpiresIn,
  MICROSOFT_GRAPH_BASE,
} from "./microsoft-oauth";

const OUTLOOK_SCOPES = "offline_access User.Read Mail.Read";

/** Tool definitions for the Outlook Mail provider. */
export const OUTLOOK_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "outlook_search",
      description:
        "Search emails in the user's Outlook mailbox. Returns message subjects and IDs.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (KQL syntax, e.g. 'from:someone@example.com')",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "outlook_get_message",
      description: "Get a specific Outlook message's subject, body preview, and headers by ID.",
      parameters: {
        type: "object",
        properties: {
          message_id: { type: "string", description: "The Outlook message ID" },
        },
        required: ["message_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "outlook_list_folders",
      description: "List all mail folders in the user's Outlook account.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

const MAX_RESULT_BYTES = 10_000;

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_BYTES) return text;
  return text.slice(0, MAX_RESULT_BYTES) + "\n…(truncated)";
}

/**
 * Dispatches an Outlook Mail tool call.
 */
export async function dispatchOutlookTool(
  conn: ConnectionRow,
  toolName: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  switch (toolName) {
    case "outlook_search":
      return outlookSearch(conn, args);
    case "outlook_get_message":
      return outlookGetMessage(conn, args);
    case "outlook_list_folders":
      return outlookListFolders(conn);
    default:
      return { content: `Unknown Outlook tool: ${toolName}` };
  }
}

async function outlookSearch(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const query = String(args.query ?? "");
  if (!query) return { content: "outlook_search: query is required" };
  // $search uses KQL syntax; Graph returns results sorted by sent date
  const url = new URL(`${MICROSOFT_GRAPH_BASE}/me/messages`);
  url.searchParams.set("$search", `"${query}"`);
  url.searchParams.set("$select", "id,subject,from,receivedDateTime");
  url.searchParams.set("$top", "10");
  const result = await callMicrosoftApi(
    conn.accessToken,
    conn.refreshToken,
    "GET",
    url.toString(),
  );
  if (!result.ok) return { content: `Outlook search failed: ${result.error}` };
  const data = result.data as { value: Array<Record<string, unknown>> };
  const messages = data.value ?? [];
  if (messages.length === 0) return { content: "No messages found." };
  const lines = [`Found ${messages.length} messages:`];
  for (const msg of messages) {
    const id = msg.id as string;
    const subject = msg.subject as string;
    const fromObj = msg.from as { emailAddress?: { address?: string } } | undefined;
    const from = fromObj?.emailAddress?.address ?? "unknown";
    const received = msg.receivedDateTime as string;
    lines.push(`- ${subject ?? "(no subject)"} from ${from} (${received}) — id: ${id}`);
  }
  return {
    content: truncate(lines.join("\n")),
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

async function outlookGetMessage(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const messageId = String(args.message_id ?? "");
  if (!messageId) return { content: "outlook_get_message: message_id is required" };
  const url = new URL(`${MICROSOFT_GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set("$select", "id,subject,from,toRecipients,receivedDateTime,bodyPreview");
  const result = await callMicrosoftApi(
    conn.accessToken,
    conn.refreshToken,
    "GET",
    url.toString(),
  );
  if (!result.ok) return { content: `Outlook get_message failed: ${result.error}` };
  const data = result.data as {
    id: string;
    subject: string;
    from: { emailAddress: { address: string; name?: string } };
    receivedDateTime: string;
    bodyPreview: string;
  };
  const fromAddr = data.from?.emailAddress?.address ?? "unknown";
  const fromName = data.from?.emailAddress?.name;
  const lines = [
    `Message ID: ${data.id}`,
    `Subject: ${data.subject ?? "(no subject)"}`,
    `From: ${fromName ? `${fromName} <${fromAddr}>` : fromAddr}`,
    `Received: ${data.receivedDateTime ?? "(unknown)"}`,
    `Preview: ${data.bodyPreview ?? ""}`,
  ];
  return {
    content: truncate(lines.join("\n")),
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

async function outlookListFolders(conn: ConnectionRow): Promise<DispatchResult> {
  const result = await callMicrosoftApi(
    conn.accessToken,
    conn.refreshToken,
    "GET",
    `${MICROSOFT_GRAPH_BASE}/me/mailFolders?$select=id,displayName,totalItemCount`,
  );
  if (!result.ok) return { content: `Outlook list_folders failed: ${result.error}` };
  const data = result.data as { value: Array<{ id: string; displayName: string; totalItemCount: number }> };
  const folders = data.value ?? [];
  if (folders.length === 0) return { content: "No mail folders found." };
  const lines = ["Mail folders:"];
  for (const folder of folders) {
    lines.push(`- ${folder.displayName} (id: ${folder.id}, ${folder.totalItemCount} items)`);
  }
  return {
    content: truncate(lines.join("\n")),
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

/** Builds the Outlook Mail OAuth authorize URL. */
export function buildOutlookAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  return buildMicrosoftAuthorizeUrl(clientId, redirectUri, state, OUTLOOK_SCOPES);
}

/** Exchanges an authorization code for Outlook Mail tokens + user profile. */
export async function exchangeOutlookCode(code: string, redirectUri: string) {
  return exchangeMicrosoftCode(code, redirectUri, OUTLOOK_SCOPES);
}

export { expiryFromExpiresIn };
