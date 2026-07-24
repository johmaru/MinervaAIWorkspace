// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn(),
}));

vi.mock("@/lib/embed", () => ({
  embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  hashContent: vi.fn((s: string) => `hash_${s.slice(0, 8)}`),
}));

vi.mock("@/db", () => ({ db: {} }));

import { getSessionUser } from "@/lib/auth-guards";
import { embedText } from "@/lib/embed";
import { PATCH } from "@/app/api/skill-candidates/[id]/route";

const mockGetSessionUser = vi.mocked(getSessionUser);
const mockEmbedText = vi.mocked(embedText);

function makeCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function patchReq(id: string, body: unknown): Request {
  return new Request(`http://localhost/api/skill-candidates/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockGetSessionUser.mockReset();
  mockEmbedText.mockReset();
  mockEmbedText.mockResolvedValue([0.1, 0.2, 0.3]);
});

describe("PATCH /api/skill-candidates/[id]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await PATCH(patchReq("c1", { status: "approved" }), makeCtx("c1"));
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid status", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const res = await PATCH(patchReq("c1", { status: "invalid" }), makeCtx("c1"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when candidate not found", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const { db } = await import("@/db");
    (db as { select: unknown }).select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    const res = await PATCH(patchReq("c1", { status: "approved" }), makeCtx("c1"));
    expect(res.status).toBe(404);
  });

  it("mergeAction=replace updates existing skill content and increments version", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });

    const existingSkill = {
      id: "skill-1",
      userId: "u1",
      name: "Old Name",
      content: "Old content",
      embedding: new Float32Array([0.1, 0.2]),
      contentHash: "hash_old",
      kind: "workflow",
      trigger: "old trigger",
      tags: ["old-tag"],
      scope: "global",
      status: "active",
      version: 1,
      sourceThreadId: null,
      sourceMessageIds: null,
      lastUsedAt: null,
      successCount: 0,
      failureCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const candidate = {
      id: "c1",
      userId: "u1",
      threadId: "t1",
      sourceMessageIds: null,
      proposedName: "New Name",
      proposedKind: "workflow",
      proposedTrigger: "new trigger",
      proposedContent: "New content that replaces old",
      proposedTags: ["new-tag"],
      confidence: 0.9,
      reason: "test",
      contentHash: "hash_new",
      duplicateOfId: "skill-1",
      duplicateOfType: "skill" as const,
      status: "draft" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const { db } = await import("@/db");

    // select() is called twice: (1) fetch candidate, (2) fetch existing skill.
    let selectCallCount = 0;
    (db as { select: unknown }).select = vi.fn().mockImplementation(() => {
      selectCallCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(
              selectCallCount === 1 ? [candidate] : [existingSkill],
            ),
          }),
        }),
      };
    });

    // Capture the update payload — db.update().set() is called twice:
    // (1) skills table with merged content, (2) skillCandidates with status="merged".
    // Only capture the first call (the skills update with computed values).
    let capturedUpdate: Record<string, unknown> = {};
    let updateCallCount = 0;
    (db as { update: unknown }).update = vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
        updateCallCount++;
        if (updateCallCount === 1) capturedUpdate = payload;
        if (updateCallCount === 1) {
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{
                ...existingSkill,
                ...payload,
                version: existingSkill.version + 1,
              }]),
            }),
          };
        }
        // Second update (skillCandidates status change) — return a thenable
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      }),
    });

    const res = await PATCH(
      patchReq("c1", { status: "approved", mergeAction: "replace", proposedName: "New Name" }),
      makeCtx("c1"),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.candidate.status).toBe("merged");
    // Verify computed values from the update payload, not just the mock return
    expect(capturedUpdate.content).toBe("New content that replaces old");
    expect(capturedUpdate.name).toBe("New Name");
    expect(capturedUpdate.version).toBe(2);
    expect(json.skill.version).toBe(2);
    expect(json.skill.content).toBe("New content that replaces old");

    // Verify embedText was called once (not twice — merge path runs before normal embedding)
    expect(mockEmbedText).toHaveBeenCalledTimes(1);
  });

  it("mergeAction=append appends to existing skill content", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });

    const existingSkill = {
      id: "skill-2",
      userId: "u1",
      name: "Base Skill",
      content: "Base content.",
      embedding: new Float32Array([0.1, 0.2]),
      contentHash: "hash_base",
      kind: "workflow",
      trigger: "base trigger",
      tags: ["base"],
      scope: "global",
      status: "active",
      version: 3,
      sourceThreadId: null,
      sourceMessageIds: null,
      lastUsedAt: null,
      successCount: 0,
      failureCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const candidate = {
      id: "c2",
      userId: "u1",
      threadId: "t2",
      sourceMessageIds: null,
      proposedName: "Addition",
      proposedKind: "workflow",
      proposedTrigger: "extra trigger",
      proposedContent: "Additional content.",
      proposedTags: ["extra"],
      confidence: 0.8,
      reason: "append test",
      contentHash: "hash_add",
      duplicateOfId: "skill-2",
      duplicateOfType: "skill" as const,
      status: "draft" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const { db } = await import("@/db");

    // select() is called twice: (1) fetch candidate, (2) fetch existing skill.
    let selectCallCount = 0;
    (db as { select: unknown }).select = vi.fn().mockImplementation(() => {
      selectCallCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(
              selectCallCount === 1 ? [candidate] : [existingSkill],
            ),
          }),
        }),
      };
    });

    // Capture the update payload — db.update().set() is called twice:
    // (1) skills table with merged content, (2) skillCandidates with status="merged".
    // Only capture the first call (the skills update with computed values).
    let capturedUpdate: Record<string, unknown> = {};
    let updateCallCount = 0;
    (db as { update: unknown }).update = vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
        updateCallCount++;
        if (updateCallCount === 1) capturedUpdate = payload;
        if (updateCallCount === 1) {
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{
                ...existingSkill,
                ...payload,
                version: existingSkill.version + 1,
              }]),
            }),
          };
        }
        // Second update (skillCandidates status change) — return a thenable
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      }),
    });

    const res = await PATCH(
      patchReq("c2", { status: "approved", mergeAction: "append" }),
      makeCtx("c2"),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    // Verify computed values from the update payload
    expect(capturedUpdate.content).toBe("Base content.\n\nAdditional content.");
    expect(capturedUpdate.version).toBe(4);
    expect(json.skill.content).toBe("Base content.\n\nAdditional content.");
    expect(json.skill.version).toBe(4);
  });

  it("falls through to normal approve when referenced skill was deleted", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });

    const candidate = {
      id: "c3",
      userId: "u1",
      threadId: "t3",
      sourceMessageIds: null,
      proposedName: "Ghost",
      proposedKind: "workflow",
      proposedTrigger: "trigger",
      proposedContent: "Content",
      proposedTags: [],
      confidence: 0.5,
      reason: "test",
      contentHash: "hash_ghost",
      duplicateOfId: "skill-missing",
      duplicateOfType: "skill" as const,
      status: "draft" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const { db } = await import("@/db");

    // First select() returns candidate; second select() (for skill) returns [] (deleted).
    let callCount = 0;
    (db as { select: unknown }).select = vi.fn().mockImplementation(() => {
      callCount++;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(callCount === 1 ? [candidate] : []),
          }),
        }),
      };
    });
    // update() for clearing stale duplicateOfId on candidate
    (db as { update: unknown }).update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
    // insert() for creating new skill (normal approve path)
    const mockSkillRow = { id: "new-skill-id", name: "Ghost", content: "Content", kind: "workflow", trigger: "trigger", tags: [] };
    (db as { insert: unknown }).insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([mockSkillRow]),
      }),
    });
    // Second update() for setting candidate status to "approved"
    (db as { update: unknown }).update = vi.fn().mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const res = await PATCH(
      patchReq("c3", { status: "approved", mergeAction: "replace" }),
      makeCtx("c3"),
    );

    // Should NOT return 404 — falls through to normal approve
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.candidate.status).toBe("approved");
    expect(json.skill.id).toBe("new-skill-id");
  });
});
