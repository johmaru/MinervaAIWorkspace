// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseCandidates } from "@/lib/skillCandidate";

describe("parseCandidates", () => {
  it("extracts candidates from array-format JSON", () => {
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

  it("returns empty array for empty array input", () => {
    const result = parseCandidates("[]");
    expect(result).toEqual([]);
  });

  it("limits to at most 3 candidates", () => {
    const raw = JSON.stringify([
      { name: "A", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
      { name: "B", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
      { name: "C", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
      { name: "D", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
    ]);
    const result = parseCandidates(raw);
    expect(result).toHaveLength(3);
  });

  it("falls back to workflow when kind is invalid", () => {
    const raw = JSON.stringify([
      { name: "X", kind: "invalid", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
    ]);
    const result = parseCandidates(raw);
    expect(result![0].kind).toBe("workflow");
  });

  it("clamps confidence when out of range", () => {
    const raw = JSON.stringify([
      { name: "X", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: 1.5, reason: "r" },
      { name: "Y", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: -0.5, reason: "r" },
    ]);
    const result = parseCandidates(raw);
    expect(result![0].confidence).toBe(1);
    expect(result![1].confidence).toBe(0);
  });

  it("skips entries with empty name", () => {
    const raw = JSON.stringify([
      { name: "", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
      { name: "Valid", kind: "workflow", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
    ]);
    const result = parseCandidates(raw);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("Valid");
  });

  it("returns null for null/undefined/empty string input", () => {
    expect(parseCandidates(null)).toBeNull();
    expect(parseCandidates(undefined)).toBeNull();
    expect(parseCandidates("")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseCandidates("not json")).toBeNull();
  });

  it("returns null for non-array JSON", () => {
    expect(parseCandidates('{"name":"x"}')).toBeNull();
  });

  it("removes markdown fences", () => {
    const raw = "```json\n" + JSON.stringify([
      { name: "Fenced", kind: "debugging", trigger: "t", tags: [], content: "c", confidence: 0.5, reason: "r" },
    ]) + "\n```";
    const result = parseCandidates(raw);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("Fenced");
  });
});
