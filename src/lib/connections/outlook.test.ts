// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchOutlookTool, OUTLOOK_TOOLS } from "./outlook";
import type { ConnectionRow } from "./types";

function mockConn(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "conn-1",
    provider: "outlook",
    accessToken: "eyJ.test",
    refreshToken: "M.R3 refresh",
    scopes: "offline_access User.Read Mail.Read",
    expiresAt: null,
    workspaceName: "Outlook",
    ...overrides,
  };
}

describe("OUTLOOK_TOOLS", () => {
  it("has 3 tools with outlook_ prefix", () => {
    expect(OUTLOOK_TOOLS).toHaveLength(3);
    for (const tool of OUTLOOK_TOOLS) {
      expect(tool.function.name.startsWith("outlook_")).toBe(true);
    }
  });
});

describe("dispatchOutlookTool", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns error for unknown tool", async () => {
    const result = await dispatchOutlookTool(mockConn(), "outlook_unknown", {});
    expect(result.content).toContain("Unknown Outlook tool");
  });

  it("outlook_search formats message list", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          value: [
            { id: "msg1", subject: "Hello", from: { emailAddress: { address: "a@b.com" } }, receivedDateTime: "2026-01-01" },
            { id: "msg2", subject: "World", from: { emailAddress: { address: "c@d.com" } }, receivedDateTime: "2026-01-02" },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchOutlookTool(mockConn(), "outlook_search", { query: "hello" });
    expect(result.content).toContain("Found 2 messages");
    expect(result.content).toContain("Hello");
    expect(result.content).toContain("a@b.com");
  });

  it("outlook_search returns no messages found", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ value: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchOutlookTool(mockConn(), "outlook_search", { query: "none" });
    expect(result.content).toBe("No messages found.");
  });

  it("outlook_get_message extracts headers", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "msg1",
          subject: "Test email",
          from: { emailAddress: { address: "sender@example.com", name: "Sender" } },
          receivedDateTime: "2026-01-01T00:00:00Z",
          bodyPreview: "Hello world preview",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchOutlookTool(mockConn(), "outlook_get_message", { message_id: "msg1" });
    expect(result.content).toContain("Subject: Test email");
    expect(result.content).toContain("Sender <sender@example.com>");
    expect(result.content).toContain("Preview: Hello world preview");
  });

  it("outlook_list_folders returns folder names", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          value: [
            { id: "inbox", displayName: "Inbox", totalItemCount: 42 },
            { id: "sent", displayName: "Sent Items", totalItemCount: 10 },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchOutlookTool(mockConn(), "outlook_list_folders", {});
    expect(result.content).toContain("Inbox");
    expect(result.content).toContain("Sent Items");
    expect(result.content).toContain("42 items");
  });
});
