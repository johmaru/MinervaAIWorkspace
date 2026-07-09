// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn(),
}));

vi.mock("@/lib/embed", () => ({
  embedText: vi.fn(),
  hashContent: vi.fn(),
}));

vi.mock("@/db", () => ({ db: {} }));

import { getSessionUser } from "@/lib/auth-guards";
import { embedText, hashContent } from "@/lib/embed";
import { PATCH, DELETE } from "@/app/api/skills/[id]/route";

const mockGetSessionUser = vi.mocked(getSessionUser);
const mockEmbedText = vi.mocked(embedText);
const mockHashContent = vi.mocked(hashContent);

beforeEach(() => {
  mockGetSessionUser.mockReset();
  mockEmbedText.mockReset();
  mockHashContent.mockReset();
});

function makeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patchReq(id: string, body: unknown): Request {
  return new Request(`http://localhost/api/skills/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/skills/[id]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await PATCH(patchReq("s1", { name: "x" }), makeCtx("s1"));
    expect(res.status).toBe(401);
  });

  it("invalid JSON returns 400", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const res = await PATCH(
      new Request("http://localhost/api/skills/s1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
      makeCtx("s1"),
    );
    expect(res.status).toBe(400);
  });

  it("non-existent skill returns 404", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const { db } = await import("@/db");
    (db as { select: unknown }).select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    const res = await PATCH(patchReq("s1", { name: "x" }), makeCtx("s1"));
    expect(res.status).toBe(404);
  });

  it("re-embeds on trigger change (even without content change)", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    mockEmbedText.mockResolvedValue([0.5, 0.5, 0.5]);
    const { db } = await import("@/db");
    const existingSkill = {
      id: "s1",
      userId: "u1",
      name: "Old Name",
      content: "Old content.",
      kind: "workflow",
      trigger: "old trigger",
      tags: ["old"],
      status: "active",
      version: 1,
    };
    (db as { select: unknown }).select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([existingSkill]),
        }),
      }),
    });
    const updateSpy = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...existingSkill, trigger: "new trigger" }]),
        }),
      }),
    });
    (db as { update: unknown }).update = updateSpy;

    const res = await PATCH(
      patchReq("s1", { trigger: "new trigger" }),
      makeCtx("s1"),
    );

    expect(res.status).toBe(200);
    // embedText was called = re-embed executed due to trigger change
    expect(mockEmbedText).toHaveBeenCalledTimes(1);
    const embedArg = mockEmbedText.mock.calls[0]?.[0] as string;
    expect(embedArg).toContain("new trigger");
  });

  it("does not re-embed when only status changes", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const { db } = await import("@/db");
    const existingSkill = {
      id: "s1",
      userId: "u1",
      name: "Name",
      content: "content.",
      kind: "workflow",
      trigger: "trigger",
      tags: [],
      status: "active",
      version: 1,
    };
    (db as { select: unknown }).select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([existingSkill]),
        }),
      }),
    });
    (db as { update: unknown }).update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...existingSkill, status: "archived" }]),
        }),
      }),
    });

    const res = await PATCH(
      patchReq("s1", { status: "archived" }),
      makeCtx("s1"),
    );

    expect(res.status).toBe(200);
    expect(mockEmbedText).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/skills/[id]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await DELETE(
      new Request("http://localhost", { method: "DELETE" }),
      makeCtx("s1"),
    );
    expect(res.status).toBe(401);
  });
});
