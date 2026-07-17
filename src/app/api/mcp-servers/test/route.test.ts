// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock auth-guards so we don't need a real session.
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn(),
}));

// Mock mcpClient so no real network/process connections happen.
vi.mock("@/lib/mcpClient", () => ({
  connectMcpServer: vi.fn(),
  listMcpTools: vi.fn(),
  validateMcpStdioCommand: vi.fn(),
}));

// Mock db so no real SQLite is hit.
vi.mock("@/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

// Mock logger to keep test output clean.
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { getSessionUser } from "@/lib/auth-guards";
import { connectMcpServer, listMcpTools, validateMcpStdioCommand } from "@/lib/mcpClient";
import { POST } from "./route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/mcp-servers/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(getSessionUser).mockResolvedValue({ id: "user-1", email: "test@test.com" } as never);
  vi.mocked(validateMcpStdioCommand).mockReturnValue({ allowed: true });
  vi.mocked(connectMcpServer).mockResolvedValue({
    client: { close: vi.fn().mockResolvedValue(undefined) } as never,
    serverId: "test",
    serverName: "test-server",
  });
  vi.mocked(listMcpTools).mockResolvedValue([
    { serverId: "test", serverName: "test-server", toolName: "echo", description: "echo tool", inputSchema: {} },
  ]);
  // Clear call history between tests to avoid cross-test pollution.
  vi.mocked(connectMcpServer).mockClear();
  vi.mocked(listMcpTools).mockClear();
  vi.mocked(validateMcpStdioCommand).mockClear();
});

describe("POST /api/mcp-servers/test", () => {
  it("returns 401 when not authenticated", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const res = await POST(makeRequest({ transport: "http", url: "https://example.com/mcp" }));
    expect(res.status).toBe(401);
  });

  it("returns ok:false for invalid transport", async () => {
    const res = await POST(makeRequest({ transport: "websocket" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain("transport");
  });

  it("returns ok:false when url missing for http", async () => {
    const res = await POST(makeRequest({ transport: "http" }));
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain("url");
  });

  it("returns ok:false when url is private IP without env", async () => {
    const res = await POST(makeRequest({ transport: "http", url: "https://127.0.0.1/mcp" }));
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid URL");
  });

  it("returns ok:false when command missing for stdio", async () => {
    const res = await POST(makeRequest({ transport: "stdio" }));
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain("command");
  });

  it("returns ok:false when stdio command is blocked", async () => {
    vi.mocked(validateMcpStdioCommand).mockReturnValue({ allowed: false, reason: "blocked binary" });
    const res = await POST(makeRequest({ transport: "stdio", command: "docker" }));
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain("Invalid command");
  });

  it("returns ok:true with tools on successful http connection", async () => {
    const res = await POST(makeRequest({
      transport: "http",
      url: "https://example.com/mcp",
      name: "my-server",
    }));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.transportUsed).toBe("http");
    expect(data.tools).toHaveLength(1);
    expect(data.tools[0].name).toBe("echo");
  });

  it("returns ok:true with tools on successful sse connection", async () => {
    const res = await POST(makeRequest({
      transport: "sse",
      url: "https://example.com/sse",
    }));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.transportUsed).toBe("sse");
  });

  it("returns ok:false when connectMcpServer returns null", async () => {
    vi.mocked(connectMcpServer).mockResolvedValue(null);
    const res = await POST(makeRequest({
      transport: "http",
      url: "https://example.com/mcp",
    }));
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain("failed or timed out");
  });

  it("closes the client after listing tools", async () => {
    const closeSpy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(connectMcpServer).mockResolvedValue({
      client: { close: closeSpy } as never,
      serverId: "test",
      serverName: "test-server",
    });
    await POST(makeRequest({ transport: "http", url: "https://example.com/mcp" }));
    expect(closeSpy).toHaveBeenCalled();
  });

  it("accepts headers for remote transport", async () => {
    const res = await POST(makeRequest({
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer xyz" },
    }));
    const data = await res.json();
    expect(data.ok).toBe(true);
    // connectMcpServer should have been called with headers
    const config = vi.mocked(connectMcpServer).mock.calls[0][0];
    expect(config.headers).toEqual({ Authorization: "Bearer xyz" });
  });

  it("returns ok:false on invalid JSON body", async () => {
    const res = await POST(new Request("http://localhost/api/mcp-servers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    }));
    expect(res.status).toBe(400);
  });
});
