// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  formatToolOutcomeForModel,
  outcomeOk,
  outcomeEmpty,
  outcomeError,
  outcomeBlocked,
  type ToolOutcome,
} from "./toolOutcome";

describe("formatToolOutcomeForModel", () => {
  it("renders ok outcome with body and no next hint", () => {
    const o: ToolOutcome = {
      tool: "read_file",
      status: "ok",
      summary: "Read src/main.ts",
      body: "import { x } from 'y'",
    };
    const s = formatToolOutcomeForModel(o);
    expect(s).toContain("[tool=read_file status=ok]");
    expect(s).toContain("summary: Read src/main.ts");
    expect(s).not.toContain("next:");
    expect(s).toContain("---");
    expect(s).toContain("import { x } from 'y'");
  });

  it("renders error outcome with next hint and code", () => {
    const o: ToolOutcome = {
      tool: "read_file",
      status: "error",
      summary: "File not found",
      body: "Error: ENOENT: no such file 'missing.ts'",
      nextHint: "Use search_files to locate the file by pattern.",
      code: "ENOENT",
    };
    const s = formatToolOutcomeForModel(o);
    expect(s).toContain("[tool=read_file status=error code=ENOENT]");
    expect(s).toContain("next: Use search_files to locate the file by pattern.");
  });

  it("renders empty outcome with next hint", () => {
    const o: ToolOutcome = {
      tool: "search_files",
      status: "empty",
      summary: "No files matched",
      body: "[SEARCH empty] No files matched pattern='*.xyz'",
      nextHint: "Broaden the glob pattern or search a different path.",
    };
    const s = formatToolOutcomeForModel(o);
    expect(s).toContain("[tool=search_files status=empty]");
    expect(s).toContain("next: Broaden the glob pattern or search a different path.");
  });

  it("renders blocked outcome with next hint and code", () => {
    const o: ToolOutcome = {
      tool: "list_directory",
      status: "blocked",
      summary: "Loop detected on this path",
      body: "You have listed this path 3 times. Summarize what you found.",
      nextHint: "Stop listing this directory. Use search_files or grep_content instead.",
      code: "LOOP_G3",
    };
    const s = formatToolOutcomeForModel(o);
    expect(s).toContain("[tool=list_directory status=blocked code=LOOP_G3]");
    expect(s).toContain("next: Stop listing this directory.");
  });

  it("renders partial outcome with body", () => {
    const o: ToolOutcome = {
      tool: "read_file",
      status: "partial",
      summary: "File too large, showing first 1MB",
      body: "...truncated content...",
      nextHint: "The file is larger than 1MB. Use grep_content to search within it.",
    };
    const s = formatToolOutcomeForModel(o);
    expect(s).toContain("[tool=read_file status=partial]");
    expect(s).toContain("next: The file is larger than 1MB.");
  });
});

describe("outcomeOk factory", () => {
  it("builds ok outcome from body, auto-derives summary when omitted", () => {
    const o = outcomeOk("read_file", "file contents here");
    expect(o.status).toBe("ok");
    expect(o.tool).toBe("read_file");
    expect(o.body).toBe("file contents here");
    expect(o.nextHint).toBeUndefined();
    expect(o.code).toBeUndefined();
    // summary auto-derived from body when not provided
    expect(o.summary).toBeTruthy();
  });

  it("uses provided summary", () => {
    const o = outcomeOk("write_file", "done", "Wrote 42 bytes");
    expect(o.summary).toBe("Wrote 42 bytes");
  });

  it("derives summary from body when body is long", () => {
    const longBody = "x".repeat(200);
    const o = outcomeOk("grep_content", longBody);
    expect(o.summary!.length).toBeLessThanOrEqual(80);
  });
});

describe("outcomeEmpty factory", () => {
  it("requires nextHint", () => {
    const o = outcomeEmpty("search_files", "No matches", "Try a broader pattern.");
    expect(o.status).toBe("empty");
    expect(o.nextHint).toBe("Try a broader pattern.");
    expect(o.summary).toBe("No matches");
  });

  it("accepts optional code", () => {
    const o = outcomeEmpty("grep_content", "empty", "broaden regex", "EMPTY_GREP");
    expect(o.code).toBe("EMPTY_GREP");
  });
});

describe("outcomeError factory", () => {
  it("requires nextHint", () => {
    const o = outcomeError("read_file", "ENOENT", "Use search_files to find it.");
    expect(o.status).toBe("error");
    expect(o.nextHint).toBe("Use search_files to find it.");
    expect(o.summary).toBe("ENOENT");
  });

  it("accepts optional code", () => {
    const o = outcomeError("read_file", "fail", "retry", "ENOENT");
    expect(o.code).toBe("ENOENT");
  });
});

describe("outcomeBlocked factory", () => {
  it("requires nextHint", () => {
    const o = outcomeBlocked("list_directory", "Loop", "Stop listing this path.");
    expect(o.status).toBe("blocked");
    expect(o.nextHint).toBe("Stop listing this path.");
    expect(o.summary).toBe("Loop");
  });

  it("accepts optional code", () => {
    const o = outcomeBlocked("search_files", "blocked", "stop", "LOOP_G2");
    expect(o.code).toBe("LOOP_G2");
  });
});
