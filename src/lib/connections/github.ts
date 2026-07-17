/**
 * GitHub OAuth Connection provider.
 *
 * OAuth App flow (not GitHub App). Per Phase 0 verification:
 * - OAuth App tokens do NOT expire and have NO refresh token.
 * - Token exchange MUST send `Accept: application/json` (default is form-encoded).
 * - API calls require `User-Agent` header (omission → rejection).
 * - Contents endpoint path slashes must be %2F-encoded.
 *
 * Verified endpoints (2026-07-17, docs.github.com):
 * - Auth:     https://github.com/login/oauth/authorize
 * - Token:    https://github.com/login/oauth/access_token
 * - API base: https://api.github.com
 *
 * Scopes: `read:user repo`
 * Headers: Authorization: Bearer, Accept: application/vnd.github+json,
 *          X-GitHub-Api-Version: 2022-11-28, User-Agent: UmansChat
 */

import type { ConnectionRow, DispatchResult } from "./types";

const AUTH_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";
const SCOPES = "read:user repo";

/** Max bytes of tool result text before truncation. */
const MAX_RESULT_BYTES = 10_000;

export const GITHUB_SCOPES = SCOPES;

/**
 * Builds the GitHub OAuth authorize URL.
 */
export function buildGithubAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
  });
  return `${AUTH_URL}?${params}`;
}

export type GithubTokenResponse = {
  access_token: string;
  token_type: string;
  scope: string;
};

export type GithubUser = {
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  id: number;
};

/**
 * Exchanges an authorization code for an access token.
 * MUST send Accept: application/json to get JSON (default is form-encoded).
 */
export async function exchangeGithubCode(
  code: string,
  redirectUri: string,
): Promise<GithubTokenResponse & { user: GithubUser }> {
  const clientId = process.env.GITHUB_CONNECTIONS_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CONNECTIONS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GITHUB_CONNECTIONS_CLIENT_ID or GITHUB_CONNECTIONS_CLIENT_SECRET is not set");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub token exchange failed: ${res.status}`);
  }
  const token = (await res.json()) as GithubTokenResponse;
  if (!token.access_token) {
    throw new Error("GitHub token exchange returned no access_token");
  }

  // Fetch user profile for display metadata
  const user = await fetchGithubUser(token.access_token);
  return { ...token, user };
}

/**
 * Fetches the authenticated user's profile (for display metadata on connect).
 */
async function fetchGithubUser(accessToken: string): Promise<GithubUser> {
  const res = await fetch(`${API_BASE}/user`, {
    headers: githubHeaders(accessToken),
  });
  if (!res.ok) {
    throw new Error(`GitHub /user failed: ${res.status}`);
  }
  return (await res.json()) as GithubUser;
}

/** Standard headers for GitHub REST API calls. */
function githubHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "UmansChat",
  };
}

/**
 * Calls the GitHub REST API. Returns parsed JSON or an error.
 * GitHub OAuth App tokens don't expire, so there's no refresh flow.
 * On 401/403, the caller should prompt the user to re-connect.
 */
export async function callGithubApi(
  accessToken: string,
  method: string,
  path: string,
  query?: Record<string, string>,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string; status: number }> {
  const url = new URL(`${API_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url, {
    method,
    headers: githubHeaders(accessToken),
  });
  if (!res.ok) {
    const errorText = await res.text();
    const rateLimited = res.headers.get("x-ratelimit-remaining") === "0";
    return {
      ok: false,
      error: rateLimited
        ? `GitHub API rate limited (resets at ${res.headers.get("x-ratelimit-reset") ?? "unknown"})`
        : errorText || `GitHub API error: ${res.status}`,
      status: res.status,
    };
  }
  return { ok: true, data: await res.json() };
}

/** Truncates text to ~10KB with a marker if cut. */
function truncate(text: string): string {
  if (text.length <= MAX_RESULT_BYTES) return text;
  return text.slice(0, MAX_RESULT_BYTES) + "\n…(truncated)";
}

/** Tool definitions for the GitHub provider. */
export const GITHUB_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "github_search_repos",
      description:
        "Search GitHub repositories by query. Returns a list of repos with owner, name, description, stars, and language.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (GitHub search syntax)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "github_list_issues",
      description:
        "List issues for a GitHub repository. Returns issue numbers, titles, state, and labels.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner (login)" },
          repo: { type: "string", description: "Repository name" },
          state: {
            type: "string",
            enum: ["open", "closed", "all"],
            description: "Issue state filter (default: open)",
          },
        },
        required: ["owner", "repo"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "github_get_file",
      description:
        "Get the contents of a text file from a GitHub repository. Returns file content or metadata for directories. Rejects binary/large files.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repository owner (login)" },
          repo: { type: "string", description: "Repository name" },
          path: { type: "string", description: "File path within the repository" },
          ref: { type: "string", description: "Git ref (branch, tag, or commit). Defaults to repo default branch." },
        },
        required: ["owner", "repo", "path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "github_search_code",
      description:
        "Search code across GitHub repositories. Requires authentication. Rate limited to 10 requests/minute. Returns file paths and matching snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Code search query (GitHub code search syntax)" },
        },
        required: ["query"],
      },
    },
  },
];

/**
 * Dispatches a GitHub tool call. Returns text content.
 * GitHub tokens don't expire, so no refresh/newAccessToken is returned.
 */
export async function dispatchGithubTool(
  conn: ConnectionRow,
  toolName: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  switch (toolName) {
    case "github_search_repos":
      return githubSearchRepos(conn, args);
    case "github_list_issues":
      return githubListIssues(conn, args);
    case "github_get_file":
      return githubGetFile(conn, args);
    case "github_search_code":
      return githubSearchCode(conn, args);
    default:
      return { content: `Unknown GitHub tool: ${toolName}` };
  }
}

async function githubSearchRepos(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const query = String(args.query ?? "");
  if (!query) return { content: "github_search_repos: query is required" };
  const result = await callGithubApi(conn.accessToken, "GET", "/search/repositories", {
    q: query,
    per_page: "10",
  });
  if (!result.ok) return { content: `GitHub search repos failed: ${result.error}` };
  const data = result.data as { total_count: number; items: Array<Record<string, unknown>> };
  const lines = [`Found ${data.total_count} repositories (showing top ${data.items?.length ?? 0}):`];
  for (const repo of data.items ?? []) {
    const fullName = repo.full_name as string;
    const desc = repo.description as string | null;
    const stars = repo.stargazers_count as number;
    const lang = repo.language as string | null;
    lines.push(`- ${fullName} ★${stars} ${lang ? `(${lang})` : ""} — ${desc ?? "(no description)"}`);
  }
  return { content: truncate(lines.join("\n")) };
}

async function githubListIssues(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const owner = String(args.owner ?? "");
  const repo = String(args.repo ?? "");
  if (!owner || !repo) return { content: "github_list_issues: owner and repo are required" };
  const state = (args.state as string) || "open";
  const result = await callGithubApi(conn.accessToken, "GET", `/repos/${owner}/${repo}/issues`, {
    state,
    per_page: "20",
  });
  if (!result.ok) return { content: `GitHub list issues failed: ${result.error}` };
  const issues = result.data as Array<Record<string, unknown>>;
  if (!issues || issues.length === 0) return { content: `No ${state} issues in ${owner}/${repo}.` };
  const lines = [`${state} issues in ${owner}/${repo}:`];
  for (const issue of issues) {
    // Skip PRs (GitHub treats PRs as issues; they have a pull_request key)
    if (issue.pull_request) continue;
    const num = issue.number as number;
    const title = issue.title as string;
    const labels = (issue.labels as Array<{ name: string }>)?.map((l) => l.name).join(", ") ?? "";
    lines.push(`- #${num} ${title}${labels ? ` [${labels}]` : ""}`);
  }
  return { content: truncate(lines.join("\n")) };
}

async function githubGetFile(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const owner = String(args.owner ?? "");
  const repo = String(args.repo ?? "");
  const path = String(args.path ?? "");
  if (!owner || !repo || !path) {
    return { content: "github_get_file: owner, repo, and path are required" };
  }
  const ref = args.ref ? String(args.ref) : undefined;
  // Slashes in {path} must be %2F-encoded per GitHub docs
  const encodedPath = path.split("/").map(encodeURIComponent).join("%2F");
  const result = await callGithubApi(
    conn.accessToken,
    "GET",
    `/repos/${owner}/${repo}/contents/${encodedPath}`,
    ref ? { ref } : undefined,
  );
  if (!result.ok) return { content: `GitHub get_file failed: ${result.error}` };
  const data = result.data as Record<string, unknown>;
  // Directory listing
  if (Array.isArray(data)) {
    const lines = [`Directory: ${path}`];
    for (const item of data) {
      const itemName = (item as Record<string, unknown>).name as string;
      const itemType = (item as Record<string, unknown>).type as string;
      lines.push(`- [${itemType}] ${itemName}`);
    }
    return { content: truncate(lines.join("\n")) };
  }
  // File content
  const encoding = data.encoding as string;
  const content = data.content as string;
  const size = data.size as number;
  const mimeType = (data.type as string) ?? "file";
  if (encoding === "base64") {
    // Reject large/binary files
    if (size > 1_000_000) {
      return { content: `File too large (${size} bytes). Use the raw API or clone the repo.` };
    }
    try {
      const decoded = Buffer.from(content, "base64").toString("utf-8");
      // Detect binary (null bytes)
      if (decoded.includes("\0")) {
        return { content: `Binary file: ${mimeType} (${size} bytes). Cannot display as text.` };
      }
      return { content: truncate(decoded) };
    } catch {
      return { content: `Failed to decode file: ${mimeType}` };
    }
  }
  // Non-base64 (shouldn't happen for files, but handle gracefully)
  return { content: truncate(JSON.stringify(data, null, 2)) };
}

async function githubSearchCode(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const query = String(args.query ?? "");
  if (!query) return { content: "github_search_code: query is required" };
  const result = await callGithubApi(conn.accessToken, "GET", "/search/code", {
    q: query,
    per_page: "10",
  });
  if (!result.ok) return { content: `GitHub search code failed: ${result.error}` };
  const data = result.data as { total_count: number; items: Array<Record<string, unknown>> };
  const lines = [`Found ${data.total_count} code results (showing top ${data.items?.length ?? 0}):`];
  for (const item of data.items ?? []) {
    const repo = (item.repository as Record<string, unknown>)?.full_name as string;
    const path = item.path as string;
    lines.push(`- ${repo}/${path}`);
  }
  return { content: truncate(lines.join("\n")) };
}
