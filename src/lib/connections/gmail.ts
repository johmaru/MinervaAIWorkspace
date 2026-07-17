/**
 * Gmail OAuth Connection provider.
 *
 * Uses the shared google-oauth.ts helper for token exchange/refresh.
 *
 * Verified endpoints (2026-07-17, developers.google.com):
 * - messages.list: GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=&maxResults=
 * - messages.get:  GET https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=metadata
 * - labels.list:   GET https://gmail.googleapis.com/gmail/v1/users/me/labels
 *
 * Scope: https://www.googleapis.com/auth/gmail.readonly
 */

import type { ConnectionRow, DispatchResult } from "./types";
import {
  buildGoogleAuthorizeUrl,
  callGoogleApi,
  exchangeGoogleCode,
  expiryFromExpiresIn,
} from "./google-oauth";

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const API_BASE = "https://gmail.googleapis.com/gmail/v1";
const MAX_RESULT_BYTES = 10_000;

export const GMAIL_SCOPE_VALUE = GMAIL_SCOPE;

/** Tool definitions for the Gmail provider. */
export const GMAIL_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "gmail_search",
      description:
        "Search emails in the user's Gmail. Returns message IDs and thread IDs matching the query.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Gmail search query (e.g. 'from:someone@example.com is:unread')",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gmail_get_message",
      description: "Get a specific Gmail message's headers and snippet by message ID.",
      parameters: {
        type: "object",
        properties: {
          message_id: { type: "string", description: "The Gmail message ID" },
        },
        required: ["message_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gmail_list_labels",
      description: "List all labels in the user's Gmail account.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

/** Truncates text to ~10KB with a marker if cut. */
function truncate(text: string): string {
  if (text.length <= MAX_RESULT_BYTES) return text;
  return text.slice(0, MAX_RESULT_BYTES) + "\n…(truncated)";
}

/**
 * Dispatches a Gmail tool call.
 */
export async function dispatchGmailTool(
  conn: ConnectionRow,
  toolName: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  switch (toolName) {
    case "gmail_search":
      return gmailSearch(conn, args);
    case "gmail_get_message":
      return gmailGetMessage(conn, args);
    case "gmail_list_labels":
      return gmailListLabels(conn);
    default:
      return { content: `Unknown Gmail tool: ${toolName}` };
  }
}

async function gmailSearch(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const query = String(args.query ?? "");
  if (!query) return { content: "gmail_search: query is required" };
  const url = new URL(`${API_BASE}/users/me/messages`);
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", "10");
  const result = await callGoogleApi(
    conn.accessToken,
    conn.refreshToken,
    "GET",
    url.toString(),
  );
  if (!result.ok) return { content: `Gmail search failed: ${result.error}` };
  const data = result.data as { messages: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number };
  const messages = data.messages ?? [];
  if (messages.length === 0) return { content: "No messages found." };
  const lines = [`Found ~${data.resultSizeEstimate ?? messages.length} messages:`];
  for (const msg of messages) {
    lines.push(`- message id: ${msg.id} (thread: ${msg.threadId})`);
  }
  return {
    content: truncate(lines.join("\n")),
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

async function gmailGetMessage(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const messageId = String(args.message_id ?? "");
  if (!messageId) return { content: "gmail_get_message: message_id is required" };
  const url = new URL(`${API_BASE}/users/me/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set("format", "metadata");
  url.searchParams.set("metadataHeaders", "From");
  url.searchParams.set("metadataHeaders", "To");
  url.searchParams.set("metadataHeaders", "Subject");
  url.searchParams.set("metadataHeaders", "Date");
  const result = await callGoogleApi(
    conn.accessToken,
    conn.refreshToken,
    "GET",
    url.toString(),
  );
  if (!result.ok) return { content: `Gmail get_message failed: ${result.error}` };
  const data = result.data as {
    id: string;
    threadId: string;
    snippet: string;
    payload?: { headers?: Array<{ name: string; value: string }> };
  };
  const headers: Record<string, string> = {};
  for (const h of data.payload?.headers ?? []) {
    headers[h.name] = h.value;
  }
  const lines = [
    `Message ID: ${data.id}`,
    `Thread ID: ${data.threadId}`,
    `From: ${headers.From ?? "(unknown)"}`,
    `To: ${headers.To ?? "(unknown)"}`,
    `Subject: ${headers.Subject ?? "(no subject)"}`,
    `Date: ${headers.Date ?? "(unknown)"}`,
    `Snippet: ${data.snippet ?? ""}`,
  ];
  return {
    content: truncate(lines.join("\n")),
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

async function gmailListLabels(conn: ConnectionRow): Promise<DispatchResult> {
  const result = await callGoogleApi(
    conn.accessToken,
    conn.refreshToken,
    "GET",
    `${API_BASE}/users/me/labels`,
  );
  if (!result.ok) return { content: `Gmail list_labels failed: ${result.error}` };
  const data = result.data as { labels: Array<{ id: string; name: string; type: string }> };
  const labels = data.labels ?? [];
  if (labels.length === 0) return { content: "No labels found." };
  const lines = ["Labels:"];
  for (const label of labels) {
    lines.push(`- ${label.name} (id: ${label.id}, type: ${label.type})`);
  }
  return {
    content: truncate(lines.join("\n")),
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

/** Builds the Gmail OAuth authorize URL. */
export function buildGmailAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  return buildGoogleAuthorizeUrl(clientId, redirectUri, state, GMAIL_SCOPE);
}

/** Exchanges an authorization code for Gmail tokens + user profile. */
export async function exchangeGmailCode(code: string, redirectUri: string) {
  return exchangeGoogleCode(code, redirectUri, GMAIL_SCOPE);
}

export { expiryFromExpiresIn };
