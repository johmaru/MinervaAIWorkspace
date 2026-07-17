/**
 * Google Drive OAuth Connection provider.
 *
 * Uses the shared google-oauth.ts helper for token exchange/refresh.
 *
 * Verified endpoints (2026-07-17, developers.google.com):
 * - files.list:  GET https://www.googleapis.com/drive/v3/files?q=&pageSize=&fields=
 * - files.get:   GET https://www.googleapis.com/drive/v3/files/{fileId}
 * - files.export: GET https://www.googleapis.com/drive/v3/files/{fileId}/export?mimeType=
 *   Docs→text/plain, Sheets→text/csv, Slides→text/plain; max 10MB
 *
 * Scope: https://www.googleapis.com/auth/drive.readonly
 */

import type { ConnectionRow, DispatchResult } from "./types";
import {
  buildGoogleAuthorizeUrl,
  callGoogleApi,
  exchangeGoogleCode,
  expiryFromExpiresIn,
} from "./google-oauth";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const API_BASE = "https://www.googleapis.com/drive/v3";
const MAX_RESULT_BYTES = 10_000;

export const GOOGLE_DRIVE_SCOPE = DRIVE_SCOPE;

/** MIME type map for Google Workspace export. */
const EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

/** Tool definitions for the Google Drive provider. */
export const GDRIVE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "gdrive_search",
      description:
        "Search files in the user's Google Drive. Returns file names, IDs, types, and modified dates.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (Google Drive query syntax, e.g. name contains 'report')",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gdrive_get_metadata",
      description: "Get metadata for a specific Google Drive file by its ID.",
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "The Google Drive file ID" },
        },
        required: ["file_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gdrive_export_text",
      description:
        "Export a Google Docs/Sheets/Slides file to text. Only works for Google Workspace files (Docs, Sheets, Slides). Returns text content.",
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "The Google Drive file ID" },
        },
        required: ["file_id"],
      },
    },
  },
];

/**
 * Dispatches a Google Drive tool call.
 */
export async function dispatchGdriveTool(
  conn: ConnectionRow,
  toolName: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  switch (toolName) {
    case "gdrive_search":
      return gdriveSearch(conn, args);
    case "gdrive_get_metadata":
      return gdriveGetMetadata(conn, args);
    case "gdrive_export_text":
      return gdriveExportText(conn, args);
    default:
      return { content: `Unknown Google Drive tool: ${toolName}` };
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_BYTES) return text;
  return text.slice(0, MAX_RESULT_BYTES) + "\n…(truncated)";
}

async function gdriveSearch(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const query = String(args.query ?? "");
  if (!query) return { content: "gdrive_search: query is required" };
  const url = new URL(`${API_BASE}/files`);
  url.searchParams.set("q", query);
  url.searchParams.set("pageSize", "10");
  url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime)");
  const result = await callGoogleApi(
    conn.accessToken,
    conn.refreshToken,
    "GET",
    url.toString(),
  );
  if (!result.ok) return { content: `Google Drive search failed: ${result.error}` };
  const data = result.data as { files: Array<Record<string, unknown>> };
  const files = data.files ?? [];
  if (files.length === 0) return { content: "No files found." };
  const lines = [`Found ${files.length} files:`];
  for (const file of files) {
    const name = file.name as string;
    const id = file.id as string;
    const mime = file.mime_type as string | undefined ?? file.mimeType as string | undefined;
    const modified = file.modifiedTime as string | undefined;
    lines.push(`- ${name} (${mime ?? "unknown"}) — id: ${id}${modified ? ` modified: ${modified}` : ""}`);
  }
  return {
    content: truncate(lines.join("\n")),
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

async function gdriveGetMetadata(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const fileId = String(args.file_id ?? "");
  if (!fileId) return { content: "gdrive_get_metadata: file_id is required" };
  const result = await callGoogleApi(
    conn.accessToken,
    conn.refreshToken,
    "GET",
    `${API_BASE}/files/${encodeURIComponent(fileId)}`,
  );
  if (!result.ok) return { content: `Google Drive get_metadata failed: ${result.error}` };
  return {
    content: truncate(JSON.stringify(result.data, null, 2)),
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

async function gdriveExportText(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const fileId = String(args.file_id ?? "");
  if (!fileId) return { content: "gdrive_export_text: file_id is required" };

  // First get the file metadata to check mimeType
  const metaResult = await callGoogleApi(
    conn.accessToken,
    conn.refreshToken,
    "GET",
    `${API_BASE}/files/${encodeURIComponent(fileId)}?fields=mimeType,name`,
  );
  if (!metaResult.ok) return { content: `Google Drive export failed: ${metaResult.error}` };
  const meta = metaResult.data as { mimeType: string; name: string };
  const exportMime = EXPORT_MIME[meta.mimeType];
  if (!exportMime) {
    return {
      content: `Cannot export file of type "${meta.mimeType}". Only Google Docs, Sheets, and Slides can be exported to text.`,
    };
  }

  // Export the file content
  const url = new URL(`${API_BASE}/files/${encodeURIComponent(fileId)}/export`);
  url.searchParams.set("mimeType", exportMime);
  const result = await callGoogleApi(
    conn.accessToken,
    conn.refreshToken,
    "GET",
    url.toString(),
  );
  if (!result.ok) return { content: `Google Drive export failed: ${result.error}` };
  // Export returns text directly (not JSON)
  const text = typeof result.data === "string" ? result.data : String(result.data);
  return {
    content: truncate(text),
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

/** Builds the Google Drive OAuth authorize URL. */
export function buildGoogleDriveAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  return buildGoogleAuthorizeUrl(clientId, redirectUri, state, DRIVE_SCOPE);
}

/** Exchanges an authorization code for Google Drive tokens + user profile. */
export async function exchangeGoogleDriveCode(
  code: string,
  redirectUri: string,
) {
  return exchangeGoogleCode(code, redirectUri, DRIVE_SCOPE);
}

export { expiryFromExpiresIn };
