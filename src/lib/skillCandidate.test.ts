// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseCandidates } from "@/lib/skillCandidate";

describe("parseCandidates", () => {
  it("配列形式の JSON から候補を抽出する", () => {
    const raw = JSON.stringify([
      {
        name: "Next.js params await",
        kind: "bugfix",
        trigger: "App Router params Promise error",
        tags: ["nextjs"],
        content: "Always await params.",
        confidence: 0.9,
        reason: "Common pitfall in Next.js 15+",
      },
    ]);
    const result = parseCandidates(raw);
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(1);
    expect(result![0].name).toBe("Next.js params await");
    expect(result![0].kind).toBe("bugfix");
    expect(result![0].confidence).toBe(0.9);
    expect(result![0].reason).toBe("Common pitfall in Next.js 15+");
  });

  it("空配列の場合は空配列を返す", () => {
    const result = parseCandidates("[]");
    expect(result).toEqual([]);
  });

  it("最大3件に制限する", () => {
    const raw = JSON.stringify([
      { name: "A", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
      { name: "B", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
      { name: "C", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
      { name: "D", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
    ]);
    const result = parseCandidates(raw);
    expect(result).toHaveLength(3);
  });

  it("kind が不正な場合は workflow にフォールバック", () => {
    const raw = JSON.stringify([
      { name: "X", kind: "invalid", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
    ]);
    const result = parseCandidates(raw);
    expect(result![0].kind).toBe("workflow");
  });

  it("confidence が範囲外の場合は clamp される", () => {
    const raw = JSON.stringify([
      { name: "X", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: 1.5, reason: "r" },
      { name: "Y", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: -0.5, reason: "r" },
    ]);
    const result = parseCandidates(raw);
    expect(result![0].confidence).toBe(1);
    expect(result![1].confidence).toBe(0);
  });

  it("name が空の要素はスキップされる", () => {
    const raw = JSON.stringify([
      { name: "", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
      { name: "Valid", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
    ]);
    const result = parseCandidates(raw);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("Valid");
  });

  it("null/undefined/空文字入力は null を返す", () => {
    expect(parseCandidates(null)).toBeNull();
    expect(parseCandidates(undefined)).toBeNull();
    expect(parseCandidates("")).toBeNull();
  });

  it("不正 JSON は null を返す", () => {
    expect(parseCandidates("not json")).toBeNull();
  });

  it("配列でない JSON は null を返す", () => {
    expect(parseCandidates('{"name":"x"}')).toBeNull();
  });

  it("markdown フェンスを除去する", () => {
    const raw = "```json\n" + JSON.stringify([
      { name: "Fenced", kind: "debugging", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
    ]) + "\n```";
    const result = parseCandidates(raw);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("Fenced");
  });
});
