// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchGdriveTool, GDRIVE_TOOLS } from "./google-drive";
import type { ConnectionRow } from "./types";

function mockConn(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "conn-1",
    provider: "google_drive",
    accessToken: "ya29.test",
    refreshToken: "1//refresh",
    scopes: "https://www.googleapis.com/auth/drive.readonly",
    expiresAt: null,
    workspaceName: "Google Drive",
    ...overrides,
  };
}

describe("GDRIVE_TOOLS", () => {
  it("has 3 tools with gdrive_ prefix", () => {
    expect(GDRIVE_TOOLS).toHaveLength(3);
    for (const tool of GDRIVE_TOOLS) {
      expect(tool.function.name.startsWith("gdrive_")).toBe(true);
    }
  });
});

describe("dispatchGdriveTool", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns error for unknown tool", async () => {
    const result = await dispatchGdriveTool(mockConn(), "gdrive_unknown", {});
    expect(result.content).toContain("Unknown Google Drive tool");
  });

  it("gdrive_search formats file list", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          files: [
            { id: "file1", name: "Report.pdf", mimeType: "application/pdf", modifiedTime: "2026-01-01" },
            { id: "file2", name: "Notes", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-01-02" },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGdriveTool(mockConn(), "gdrive_search", { query: "report" });
    expect(result.content).toContain("Found 2 files");
    expect(result.content).toContain("Report.pdf");
    expect(result.content).toContain("Notes");
  });

  it("gdrive_export_text exports Google Doc to text", async () => {
    // First call: get metadata
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ mimeType: "application/vnd.google-apps.document", name: "My Doc" }),
          { status: 200 },
        ),
      )
      // Second call: export content
      // Second call: export content (text/plain, not JSON)
      .mockResolvedValueOnce(
        new Response("Hello from Google Doc", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGdriveTool(mockConn(), "gdrive_export_text", { file_id: "file1" });
    expect(result.content).toBe("Hello from Google Doc");
  });

  it("gdrive_export_text rejects non-Google-Workspace files", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ mimeType: "application/pdf", name: "report.pdf" }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGdriveTool(mockConn(), "gdrive_export_text", { file_id: "file1" });
    expect(result.content).toContain("Cannot export");
  });
});
