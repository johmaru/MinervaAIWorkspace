// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildAssistantMetadata } from "@/app/api/chat/route";
import type { InjectedSkillInfo } from "@/lib/skillStore";

const dummySkill: InjectedSkillInfo = {
  skillId: "skill-1",
  name: "Docker rebuild",
  usageEventId: "event-1",
  similarity: 0.72,
  activationType: "semantic",
};

const dualTrace = {
  strategy: "cross_review" as const,
  modelA: "model-a",
  modelB: "model-b",
  finalModel: "final-model",
  answerA: "answer-a",
  answerB: "answer-b",
};

describe("buildAssistantMetadata", () => {
  it("merges injectedSkills with dualTrace (does not replace trace)", () => {
    const meta = buildAssistantMetadata({
      finalModel: "test-model",
      elapsedMs: 1234,
      dualTrace,
      injectedSkills: [dummySkill],
    });

    expect(meta.dualTrace).toEqual(dualTrace);
    expect(meta.injectedSkills).toEqual([dummySkill]);
    expect(meta.model).toBe("test-model");
    expect(meta.elapsedMs).toBe(1234);
  });

  it("merges injectedSkills with hyperTrace", () => {
    const hyperTrace = {
      rounds: [],
      finalModel: "hyper-model",
    };
    const meta = buildAssistantMetadata({
      finalModel: "test-model",
      elapsedMs: 500,
      hyperTrace,
      injectedSkills: [dummySkill],
    });

    expect(meta.hyperTrace).toEqual(hyperTrace);
    expect(meta.injectedSkills).toEqual([dummySkill]);
    // dualTrace must not be present
    expect(meta.dualTrace).toBeUndefined();
  });

  it("merges injectedSkills with councilTrace", () => {
    const councilTrace = {
      panels: [],
      initialAnswers: [],
      discussionTurns: [],
      finalModel: "council-model",
      roundsCompleted: 2,
      timeLimitReached: false,
    };
    const meta = buildAssistantMetadata({
      finalModel: "test-model",
      elapsedMs: 500,
      councilTrace,
      injectedSkills: [dummySkill],
    });

    expect(meta.councilTrace).toEqual(councilTrace);
    expect(meta.injectedSkills).toEqual([dummySkill]);
  });

  it("omits injectedSkills when array is empty", () => {
    const meta = buildAssistantMetadata({
      finalModel: "test-model",
      elapsedMs: 500,
      injectedSkills: [],
    });

    expect(meta.injectedSkills).toBeUndefined();
    expect(meta.model).toBe("test-model");
  });

  it("omits all traces when none provided (plain metadata)", () => {
    const meta = buildAssistantMetadata({
      finalModel: "test-model",
      elapsedMs: 500,
      injectedSkills: [],
    });

    expect(meta).toEqual({ model: "test-model", elapsedMs: 500 });
    expect(meta.dualTrace).toBeUndefined();
    expect(meta.hyperTrace).toBeUndefined();
    expect(meta.councilTrace).toBeUndefined();
    expect(meta.injectedSkills).toBeUndefined();
  });

  it("includes injectedSkills even with no trace", () => {
    const meta = buildAssistantMetadata({
      finalModel: "test-model",
      elapsedMs: 500,
      injectedSkills: [dummySkill],
    });

    expect(meta.injectedSkills).toEqual([dummySkill]);
    expect(meta.dualTrace).toBeUndefined();
  });
});
