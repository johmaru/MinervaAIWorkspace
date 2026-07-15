// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock embedText to return an empty vector (simulates embed failure in exe env
// where no embedder service is reachable).
vi.mock("@/lib/embed", () => ({
  embedText: vi.fn().mockResolvedValue([]),
  hashContent: vi.fn().mockReturnValue("hash"),
}));

// Mock the DB with insert spy so we can assert it is NOT called with an empty array.
const insertValuesSpy = vi.fn(() => ({ catch: vi.fn() }));
const updateSetWhereSpy = vi.fn(() => ({ catch: vi.fn() }));
vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => []), limit: vi.fn(() => []) })),
    })),
    insert: vi.fn(() => ({ values: insertValuesSpy })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: updateSetWhereSpy })),
    })),
  },
}));

vi.mock("@/db/schema", () => ({
  skills: {},
  skillUsageEvents: {},
}));

vi.mock("@/lib/vectorSearch", () => ({
  toVecBuffer: vi.fn().mockReturnValue(Buffer.from(new Float32Array([0]).buffer)),
  distanceToSimilarity: vi.fn().mockReturnValue(0.5),
  cosineSimilarity: vi.fn().mockReturnValue(0),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { buildSkillContext } from "@/lib/skillStore";
import { db } from "@/db";

describe("buildSkillContext empty-merged guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null and skips usage log when no skills match (embed failure)", async () => {
    // embedText returns [] → findRelevantSkills returns [] → merged is empty.
    // No named skill either → buildSkillContext must return null without
    // calling db.insert().values([]) (which throws "values() must be called
    // with at least one value" in Drizzle).
    const result = await buildSkillContext({
      content: "hello world",
      userId: "user-1",
      threadId: "thread-1",
    });

    expect(result).toBeNull();
    // insert().values() must not be called at all when merged is empty.
    expect(insertValuesSpy).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("returns null when threadId is omitted and no skills match", async () => {
    const result = await buildSkillContext({
      content: "hello world",
      userId: "user-1",
    });

    expect(result).toBeNull();
    expect(insertValuesSpy).not.toHaveBeenCalled();
  });
});
