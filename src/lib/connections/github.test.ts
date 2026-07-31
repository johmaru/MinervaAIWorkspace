// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGithubAuthorizeUrl,
  exchangeGithubCode,
  callGithubApi,
  dispatchGithubTool,
  GITHUB_TOOLS,
} from "./github";
import type { ConnectionRow } from "./types";

// GitHub token exchange returns JSON only with Accept: application/json
const TOKEN_RESPONSE = {
  access_token: "gho_testtoken123",
  token_type: "bearer",
  scope: "read:user repo",
};

const USER_RESPONSE = {
  login: "testuser",
  name: "Test User",
  email: "test@example.com",
  avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
  id: 123,
};

function mockConn(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "conn-1",
    provider: "github",
    accessToken: "gho_testtoken123",
    refreshToken: null,
    scopes: "read:user repo",
    expiresAt: null,
    workspaceName: "testuser",
    ...overrides,
  };
}

describe("buildGithubAuthorizeUrl", () => {
  it("includes client_id, redirect_uri, scope, state", () => {
    const url = buildGithubAuthorizeUrl("client-abc", "http://localhost:3001/api/connections/github/callback", "user-1");
    expect(url).toContain("client_id=client-abc");
    expect(url).toContain("redirect_uri=http");
    expect(url).toContain("scope=read");
    expect(url).toContain("state=user-1");
    expect(url).toContain("https://github.com/login/oauth/authorize");
  });
});

describe("exchangeGithubCode", () => {
  const origClientId = process.env.GITHUB_CONNECTIONS_CLIENT_ID;
  const origClientSecret = process.env.GITHUB_CONNECTIONS_CLIENT_SECRET;

  beforeEach(() => {
    process.env.GITHUB_CONNECTIONS_CLIENT_ID = "test-client-id";
    process.env.GITHUB_CONNECTIONS_CLIENT_SECRET = "test-client-secret";
  });

  afterEach(() => {
    if (origClientId === undefined) delete process.env.GITHUB_CONNECTIONS_CLIENT_ID;
    else process.env.GITHUB_CONNECTIONS_CLIENT_ID = origClientId;
    if (origClientSecret === undefined) delete process.env.GITHUB_CONNECTIONS_CLIENT_SECRET;
    else process.env.GITHUB_CONNECTIONS_CLIENT_SECRET = origClientSecret;
    vi.restoreAllMocks();
  });

  it("sends Accept: application/json header on token exchange", async () => {
    const fetchMock = vi.fn();
    // First call: token exchange
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(TOKEN_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    // Second call: /user
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(USER_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeGithubCode("test-code", "http://localhost:3001/callback");

    // Verify token exchange call had Accept: application/json
    const tokenCall = fetchMock.mock.calls[0];
    const tokenInit = tokenCall[1] as RequestInit;
    const headers = tokenInit.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/json");

    expect(result.access_token).toBe("gho_testtoken123");
    expect(result.user.login).toBe("testuser");
  });

  it("throws when env credentials are missing", async () => {
    delete process.env.GITHUB_CONNECTIONS_CLIENT_ID;
    await expect(exchangeGithubCode("code", "http://localhost/callback")).rejects.toThrow(
      "GITHUB_CONNECTIONS_CLIENT_ID",
    );
  });

  it("throws when token exchange returns no access_token", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "bad_code" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(exchangeGithubCode("bad-code", "http://localhost/callback")).rejects.toThrow(
      "no access_token",
    );
  });
});

describe("callGithubApi", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends User-Agent header (required by GitHub)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await callGithubApi("token", "GET", "/user");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("MinervaAIWorkspace");
    expect(headers.Authorization).toBe("Bearer token");
    expect(headers.Accept).toBe("application/vnd.github+json");
  });

  it("detects rate limit via x-ratelimit-remaining: 0", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response("rate limited", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callGithubApi("token", "GET", "/search/repositories");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("rate limited");
      expect(result.status).toBe(403);
    }
  });

  it("returns parsed JSON on success", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ login: "user" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callGithubApi("token", "GET", "/user");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { login: string }).login).toBe("user");
    }
  });
});

describe("dispatchGithubTool", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns error for unknown tool", async () => {
    const result = await dispatchGithubTool(mockConn(), "github_unknown", {});
    expect(result.content).toContain("Unknown GitHub tool");
  });

  it("github_search_repos formats repo list", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          total_count: 2,
          items: [
            { full_name: "octocat/hello-world", description: "My first repo", stargazers_count: 100, language: "JavaScript" },
            { full_name: "torvalds/linux", description: "Kernel", stargazers_count: 100000, language: "C" },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGithubTool(mockConn(), "github_search_repos", { query: "hello" });
    expect(result.content).toContain("Found 2 repositories");
    expect(result.content).toContain("octocat/hello-world");
    expect(result.content).toContain("torvalds/linux");
    expect(result.content).toContain("★100");
  });

  it("github_list_issues skips PRs", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { number: 1, title: "Bug report", labels: [{ name: "bug" }] },
          { number: 2, title: "PR title", pull_request: {}, labels: [] },
          { number: 3, title: "Feature request", labels: [] },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGithubTool(mockConn(), "github_list_issues", {
      owner: "octocat",
      repo: "hello-world",
    });
    expect(result.content).toContain("#1 Bug report");
    expect(result.content).toContain("#3 Feature request");
    expect(result.content).not.toContain("PR title");
  });

  it("github_get_file decodes base64 text content", async () => {
    const content = Buffer.from("Hello, world!").toString("base64");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content,
          size: 13,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGithubTool(mockConn(), "github_get_file", {
      owner: "octocat",
      repo: "hello-world",
      path: "README.md",
    });
    expect(result.content).toBe("Hello, world!");
  });

  it("github_get_file rejects large files", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content: "AAAA",
          size: 2_000_000,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGithubTool(mockConn(), "github_get_file", {
      owner: "octocat",
      repo: "hello-world",
      path: "big.bin",
    });
    expect(result.content).toContain("File too large");
  });

  it("github_get_file detects binary content", async () => {
    // base64 of a string containing null byte
    const content = Buffer.from("text\0binary", "utf-8").toString("base64");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content,
          size: 11,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGithubTool(mockConn(), "github_get_file", {
      owner: "octocat",
      repo: "hello-world",
      path: "image.png",
    });
    expect(result.content).toContain("Binary file");
  });

  it("github_get_file lists directory contents as array", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { name: "src", type: "dir" },
          { name: "README.md", type: "file" },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGithubTool(mockConn(), "github_get_file", {
      owner: "octocat",
      repo: "hello-world",
      path: ".",
    });
    expect(result.content).toContain("Directory:");
    expect(result.content).toContain("[dir] src");
    expect(result.content).toContain("[file] README.md");
  });

  it("github_search_code formats results", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          total_count: 1,
          items: [
            {
              name: "index.ts",
              path: "src/index.ts",
              repository: { full_name: "octocat/hello-world" },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGithubTool(mockConn(), "github_search_code", {
      query: "useState",
    });
    expect(result.content).toContain("Found 1 code results");
    expect(result.content).toContain("octocat/hello-world/src/index.ts");
  });

  it("truncates large results", async () => {
    const largeContent = "x".repeat(15_000);
    const content = Buffer.from(largeContent).toString("base64");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: "file",
          encoding: "base64",
          content,
          size: 15_000,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGithubTool(mockConn(), "github_get_file", {
      owner: "octocat",
      repo: "hello-world",
      path: "big.txt",
    });
    expect(result.content).toContain("(truncated)");
    expect(result.content.length).toBeLessThan(15_000);
  });
});

describe("GITHUB_TOOLS", () => {
  it("has exactly 4 tools with github_ prefix", () => {
    expect(GITHUB_TOOLS).toHaveLength(4);
    for (const tool of GITHUB_TOOLS) {
      expect(tool.function.name.startsWith("github_")).toBe(true);
    }
  });

  it("tool names are unique", () => {
    const names = GITHUB_TOOLS.map((t) => t.function.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
