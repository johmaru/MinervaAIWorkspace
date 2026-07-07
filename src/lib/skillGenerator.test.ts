// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseSkillExtraction } from "@/lib/skillGenerator";

describe("parseSkillExtraction", () => {
  it("配列形式の JSON から最初のスキルを抽出する", () => {
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

  it("単一オブジェクトも許容する（後方互換）", () => {
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

  it("空配列の場合は null を返す", () => {
    const result = parseSkillExtraction("[]");
    expect(result).toBeNull();
  });

  it("kind が不正な場合は workflow にフォールバック", () => {
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

  it("tags が配列でない場合は空配列になる", () => {
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

  it("trigger が文字列でない場合は空文字になる", () => {
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

  it("name が空の場合はスキップして次の要素を見る", () => {
    const raw = JSON.stringify([
      { name: "", kind: "bugfix", trigger: "t", tags: [], content: "c" },
      { name: "Valid", kind: "bugfix", trigger: "t", tags: [], content: "c" },
    ]);
    const result = parseSkillExtraction(raw);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Valid");
  });

  it("content が空の場合は null を返す", () => {
    const raw = JSON.stringify([
      { name: "No Content", kind: "bugfix", trigger: "t", tags: [], content: "" },
    ]);
    const result = parseSkillExtraction(raw);
    expect(result).toBeNull();
  });

  it("null/undefined/空文字入力は null を返す", () => {
    expect(parseSkillExtraction(null)).toBeNull();
    expect(parseSkillExtraction(undefined)).toBeNull();
    expect(parseSkillExtraction("")).toBeNull();
    expect(parseSkillExtraction("   ")).toBeNull();
  });

  it("不正 JSON は null を返す", () => {
    expect(parseSkillExtraction("not json")).toBeNull();
    expect(parseSkillExtraction("{broken")).toBeNull();
  });

  it("markdown コードフェンスを除去してパースする", () => {
    const raw = "```json\n" + JSON.stringify([
      { name: "Fenced", kind: "coding_pattern", trigger: "t", tags: ["a"], content: "c" },
    ]) + "\n```";
    const result = parseSkillExtraction(raw);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Fenced");
  });
});
