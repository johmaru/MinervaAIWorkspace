// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyEditFile, type EditFileApplyResult } from "./editFile";

describe("applyEditFile", () => {
  it("replaces a single exact match", () => {
    const r = applyEditFile({
      content: "hello world\nfoo bar",
      oldString: "world",
      newString: "galaxy",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newContent).toBe("hello galaxy\nfoo bar");
      expect(r.occurrences).toBe(1);
    }
  });

  it("replaces multiple matches when replaceAll=true", () => {
    const r = applyEditFile({
      content: "a.b.c.d",
      oldString: ".",
      newString: "-",
      replaceAll: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newContent).toBe("a-b-c-d");
      expect(r.occurrences).toBe(3);
    }
  });

  it("errors on zero matches (EDIT_NO_MATCH)", () => {
    const r = applyEditFile({
      content: "hello world",
      oldString: "xyz",
      newString: "abc",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("EDIT_NO_MATCH");
    }
  });

  it("errors on multiple matches without replaceAll (EDIT_AMBIGUOUS)", () => {
    const r = applyEditFile({
      content: "foo foo foo",
      oldString: "foo",
      newString: "bar",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("EDIT_AMBIGUOUS");
    }
  });

  it("errors on empty old_string (EDIT_EMPTY_OLD)", () => {
    const r = applyEditFile({
      content: "hello",
      oldString: "",
      newString: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("EDIT_EMPTY_OLD");
    }
  });

  it("allows identical old and new string (no-op replace)", () => {
    const r = applyEditFile({
      content: "hello world",
      oldString: "world",
      newString: "world",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newContent).toBe("hello world");
      expect(r.occurrences).toBe(1);
    }
  });

  it("handles multi-line old_string", () => {
    const r = applyEditFile({
      content: "line1\nline2\nline3",
      oldString: "line1\nline2",
      newString: "replaced",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newContent).toBe("replaced\nline3");
      expect(r.occurrences).toBe(1);
    }
  });

  it("replaceAll with zero matches still errors", () => {
    const r = applyEditFile({
      content: "hello world",
      oldString: "xyz",
      newString: "abc",
      replaceAll: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("EDIT_NO_MATCH");
    }
  });
});
