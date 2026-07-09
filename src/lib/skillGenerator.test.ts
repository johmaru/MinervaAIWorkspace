// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseSkillExtraction } from "@/lib/skillGenerator";

describe("parseSkillExtraction", () => {
  it("extracts the first skill from array-format JSON", () => {
    const raw = JSON.stringify([
      {
        name: "Next.js params await",
        kind: "bugfix",
        trigger: "Next.js App Router params Promise error",
        tags: ["nextjs", "app-router"],
        content: "Always await params in App Router routes.",
      },
    ]);
    const result = parseSkillExtraction(raw);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Next.js params await");
    expect(result!.kind).toBe("bugfix");
    expect(result!.trigger).toBe("Next.js App Router params Promise error");
    expect(result!.tags).toEqual(["nextjs", "app-router"]);
    expect(result!.content).toBe("Always await params in App Router routes.");
  });

  it("also accepts a single object (backward compatibility)", () => {
    const raw = JSON.stringify({
      name: "Solo Skill",
      kind: "workflow",
      trigger: "when solo",
      tags: ["solo"],
      content: "Do the solo thing.",
    });
    const result = parseSkillExtraction(raw);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Solo Skill");
    expect(result!.kind).toBe("workflow");
  });

  it("returns null for empty array", () => {
    const result = parseSkillExtraction("[]");
    expect(result).toBeNull();
  });

  it("falls back to workflow when kind is invalid", () => {
    const raw = JSON.stringify([
      {
        name: "Test Skill",
        kind: "invalid_kind",
        trigger: "when testing",
        tags: ["t1"],
        content: "Do the thing.",
      },
    ]);
    const result = parseSkillExtraction(raw);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("workflow");
  });

  it("returns empty array when tags is not an array", () => {
    const raw = JSON.stringify([
      {
        name: "No Tags",
        kind: "debugging",
        trigger: "trigger",
        tags: "not-an-array",
        content: "content.",
      },
    ]);
    const result = parseSkillExtraction(raw);
    expect(result).not.toBeNull();
    expect(result!.tags).toEqual([]);
  });

  it("returns empty string when trigger is not a string", () => {
    const raw = JSON.stringify([
      {
        name: "No Trigger",
        kind: "tool_usage",
        trigger: 123,
        tags: [],
        content: "content.",
      },
    ]);
    const result = parseSkillExtraction(raw);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe("");
  });

  it("skips entries with empty name and looks at the next entry", () => {
    const raw = JSON.stringify([
      { name: "", kind: "bugfix", trigger: "t", tags: [], content: "c" },
      { name: "Valid", kind: "bugfix", trigger: "t", tags: [], content: "c" },
    ]);
    const result = parseSkillExtraction(raw);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Valid");
  });

  it("returns null when content is empty", () => {
    const raw = JSON.stringify([
      { name: "No Content", kind: "bugfix", trigger: "t", tags: [], content: "" },
    ]);
    const result = parseSkillExtraction(raw);
    expect(result).toBeNull();
  });

  it("returns null for null/undefined/empty string input", () => {
    expect(parseSkillExtraction(null)).toBeNull();
    expect(parseSkillExtraction(undefined)).toBeNull();
    expect(parseSkillExtraction("")).toBeNull();
    expect(parseSkillExtraction("   ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseSkillExtraction("not json")).toBeNull();
    expect(parseSkillExtraction("{broken")).toBeNull();
  });

  it("parses after removing markdown code fences", () => {
    const raw = "```json\n" + JSON.stringify([
      { name: "Fenced", kind: "coding_pattern", trigger: "t", tags: ["a"], content: "c" },
    ]) + "\n```";
    const result = parseSkillExtraction(raw);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Fenced");
  });
});
