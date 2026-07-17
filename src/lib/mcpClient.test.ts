// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SDK transports so we can assert construction without real network.
// vi.hoisted ensures the mock fns are available to the hoisted vi.mock factories.
const { mockConnect } = vi.hoisted(() => ({
  mockConnect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mockConnect;
    close = vi.fn().mockResolvedValue(undefined);
    listTools = vi.fn().mockResolvedValue({ tools: [] });
    callTool = vi.fn().mockResolvedValue({ content: [] });
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(),
}));

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { connectMcpServer, validateMcpStdioCommand } from "./mcpClient";
import type { McpServerConfig } from "./mcpClient";
describe("validateMcpStdioCommand", () => {
  // --- Allowed commands ---

  it("allows npx", () => {
    const result = validateMcpStdioCommand("npx", ["-y", "@anthropic/mcp-server"]);
    expect(result.allowed).toBe(true);
  });

  it("allows node", () => {
    const result = validateMcpStdioCommand("node", ["server.js"]);
    expect(result.allowed).toBe(true);
  });

  it("allows python3", () => {
    const result = validateMcpStdioCommand("python3", ["-m", "mcp_server"]);
    expect(result.allowed).toBe(true);
  });

  it("allows uvx", () => {
    const result = validateMcpStdioCommand("uvx", ["mcp-server-fetch"]);
    expect(result.allowed).toBe(true);
  });

  it("allows bun", () => {
    const result = validateMcpStdioCommand("bun", ["run", "server.ts"]);
    expect(result.allowed).toBe(true);
  });

  it("allows path-prefixed binary", () => {
    const result = validateMcpStdioCommand("/usr/bin/node", ["server.js"]);
    expect(result.allowed).toBe(true);
  });

  it("allows Windows path-prefixed binary", () => {
    const result = validateMcpStdioCommand("C:\\Program Files\\nodejs\\node.exe", ["server.js"]);
    expect(result.allowed).toBe(true);
  });

  // --- Blocked binaries ---

  it("blocks docker", () => {
    const result = validateMcpStdioCommand("docker", ["run", "-v", "/:/host", "alpine"]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not in the allowed list");
  });

  it("blocks bash", () => {
    const result = validateMcpStdioCommand("bash", ["-c", "whoami"]);
    expect(result.allowed).toBe(false);
  });

  it("blocks sh", () => {
    const result = validateMcpStdioCommand("sh", ["-c", "whoami"]);
    expect(result.allowed).toBe(false);
  });

  it("blocks cmd.exe", () => {
    const result = validateMcpStdioCommand("cmd.exe", ["/c", "whoami"]);
    expect(result.allowed).toBe(false);
  });

  it("blocks env", () => {
    const result = validateMcpStdioCommand("env", ["rm", "-rf", "/"]);
    expect(result.allowed).toBe(false);
  });

  it("blocks curl", () => {
    const result = validateMcpStdioCommand("curl", ["http://evil.com"]);
    expect(result.allowed).toBe(false);
  });

  it("blocks rm", () => {
    const result = validateMcpStdioCommand("rm", ["-rf", "/"]);
    expect(result.allowed).toBe(false);
  });

  it("blocks powershell", () => {
    const result = validateMcpStdioCommand("powershell", ["-Command", "whoami"]);
    expect(result.allowed).toBe(false);
  });

  // --- Blocked flags ---

  it("blocks node -e (code execution)", () => {
    const result = validateMcpStdioCommand("node", ["-e", "console.log(1)"]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("-e");
  });

  it("blocks python -c (code execution)", () => {
    const result = validateMcpStdioCommand("python", ["-c", "import os"]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("-c");
  });

  it("blocks node --eval", () => {
    const result = validateMcpStdioCommand("node", ["--eval", "console.log(1)"]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("--eval");
  });

  it("blocks node --interactive", () => {
    const result = validateMcpStdioCommand("node", ["--interactive"]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("--interactive");
  });

  // --- Edge cases ---

  it("blocks empty command", () => {
    const result = validateMcpStdioCommand("", []);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("empty");
  });

  it("blocks unknown binary", () => {
    const result = validateMcpStdioCommand("some-unknown-tool", []);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not in the allowed list");
  });

  it("allows empty args with allowed binary", () => {
    const result = validateMcpStdioCommand("node", []);
    expect(result.allowed).toBe(true);
  });

  it("allows -y flag on npx", () => {
    const result = validateMcpStdioCommand("npx", ["-y", "@anthropic/mcp-server"]);
    expect(result.allowed).toBe(true);
  });

  it("allows -m flag on python", () => {
    const result = validateMcpStdioCommand("python3", ["-m", "http.server"]);
    expect(result.allowed).toBe(true);
  });
});

describe("connectMcpServer", () => {
  beforeEach(() => {
    mockConnect.mockClear();
    vi.mocked(StreamableHTTPClientTransport).mockClear();
    vi.mocked(SSEClientTransport).mockClear();
  });

  const baseConfig = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
    id: "srv-1",
    name: "test-server",
    transport: "http",
    url: "https://example.com/mcp",
    command: null,
    args: null,
    env: null,
    headers: null,
    ...overrides,
  });

  it("returns null when url is missing for http transport", async () => {
    const conn = await connectMcpServer(baseConfig({ transport: "http", url: null }));
    expect(conn).toBeNull();
  });

  it("returns null when url is missing for sse transport", async () => {
    const conn = await connectMcpServer(baseConfig({ transport: "sse", url: null }));
    expect(conn).toBeNull();
  });

  it("sse transport never constructs StreamableHTTPClientTransport", async () => {
    await connectMcpServer(baseConfig({
      transport: "sse",
      url: "https://example.com/sse",
    }));
    expect(SSEClientTransport).toHaveBeenCalledTimes(1);
    expect(StreamableHTTPClientTransport).not.toHaveBeenCalled();
  });

  it("http transport attempts StreamableHTTP first", async () => {
    await connectMcpServer(baseConfig({
      transport: "http",
      url: "https://example.com/mcp",
    }));
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    expect(SSEClientTransport).not.toHaveBeenCalled();
  });

  it("http falls back to SSE with a fresh Client when Streamable connect fails", async () => {
    // First connect (Streamable attempt) throws, second (SSE fallback) succeeds.
    mockConnect
      .mockRejectedValueOnce(new Error("streamable not supported"))
      .mockResolvedValueOnce(undefined);
    await connectMcpServer(baseConfig({
      transport: "http",
      url: "https://example.com/mcp",
    }));
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    expect(SSEClientTransport).toHaveBeenCalledTimes(1);
    // Two connect calls = two separate Client lifecycles (fresh Client per attempt)
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it("passes headers via requestInit to SSEClientTransport", async () => {
    await connectMcpServer(baseConfig({
      transport: "sse",
      url: "https://example.com/sse",
      headers: { Authorization: "Bearer secret" },
    }));
    expect(SSEClientTransport).toHaveBeenCalledTimes(1);
    const [, opts] = vi.mocked(SSEClientTransport).mock.calls[0];
    expect(opts).toEqual({ requestInit: { headers: { Authorization: "Bearer secret" } } });
  });

  it("passes headers via requestInit to StreamableHTTPClientTransport", async () => {
    await connectMcpServer(baseConfig({
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer secret" },
    }));
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1);
    const [, opts] = vi.mocked(StreamableHTTPClientTransport).mock.calls[0];
    expect(opts).toEqual({ requestInit: { headers: { Authorization: "Bearer secret" } } });
  });

  it("returns null when both Streamable and SSE fail for http transport", async () => {
    mockConnect
      .mockRejectedValueOnce(new Error("streamable fail"))
      .mockRejectedValueOnce(new Error("sse fail"));
    const conn = await connectMcpServer(baseConfig({
      transport: "http",
      url: "https://example.com/mcp",
    }));
    expect(conn).toBeNull();
  });
});
