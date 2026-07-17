// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchGmailTool, GMAIL_TOOLS } from "./gmail";
import type { ConnectionRow } from "./types";

function mockConn(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "conn-1",
    provider: "gmail",
    accessToken: "ya29.test",
    refreshToken: "1//refresh",
    scopes: "https://www.googleapis.com/auth/gmail.readonly",
    expiresAt: null,
    workspaceName: "Gmail",
    ...overrides,
  };
}

describe("GMAIL_TOOLS", () => {
  it("has 3 tools with gmail_ prefix", () => {
    expect(GMAIL_TOOLS).toHaveLength(3);
    for (const tool of GMAIL_TOOLS) {
      expect(tool.function.name.startsWith("gmail_")).toBe(true);
    }
  });
});

describe("dispatchGmailTool", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns error for unknown tool", async () => {
    const result = await dispatchGmailTool(mockConn(), "gmail_unknown", {});
    expect(result.content).toContain("Unknown Gmail tool");
  });

  it("gmail_search formats message list", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          messages: [
            { id: "msg1", threadId: "t1" },
            { id: "msg2", threadId: "t2" },
          ],
          resultSizeEstimate: 2,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGmailTool(mockConn(), "gmail_search", { query: "is:unread" });
    expect(result.content).toContain("Found ~2 messages");
    expect(result.content).toContain("msg1");
    expect(result.content).toContain("msg2");
  });

  it("gmail_search returns no messages found", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGmailTool(mockConn(), "gmail_search", { query: "nonexistent" });
    expect(result.content).toBe("No messages found.");
  });

  it("gmail_get_message extracts headers", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "msg1",
          threadId: "t1",
          snippet: "Hello world",
          payload: {
            headers: [
              { name: "From", value: "sender@example.com" },
              { name: "To", value: "me@example.com" },
              { name: "Subject", value: "Test email" },
              { name: "Date", value: "2026-01-01" },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGmailTool(mockConn(), "gmail_get_message", { message_id: "msg1" });
    expect(result.content).toContain("From: sender@example.com");
    expect(result.content).toContain("Subject: Test email");
    expect(result.content).toContain("Snippet: Hello world");
  });

  it("gmail_list_labels returns label names", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          labels: [
            { id: "INBOX", name: "INBOX", type: "system" },
            { id: "label_1", name: "Custom Label", type: "user" },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGmailTool(mockConn(), "gmail_list_labels", {});
    expect(result.content).toContain("INBOX");
    expect(result.content).toContain("Custom Label");
  });
});
