// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn(),
}));

vi.mock("@/lib/skillFeedback", () => ({
  applySkillFeedback: vi.fn(),
}));

import { getSessionUser } from "@/lib/auth-guards";
import { applySkillFeedback } from "@/lib/skillFeedback";
import { POST } from "@/app/api/skill-usage/[id]/feedback/route";

const mockGetSessionUser = vi.mocked(getSessionUser);
const mockApplySkillFeedback = vi.mocked(applySkillFeedback);

function makeCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  mockGetSessionUser.mockReset();
  mockApplySkillFeedback.mockReset();
});

describe("POST /api/skill-usage/[id]/feedback", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await POST(
      new Request("http://localhost/api/skill-usage/e1/feedback", {
        method: "POST",
        body: JSON.stringify({ outcome: "helpful" }),
      }),
      makeCtx("e1"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid outcome", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const res = await POST(
      new Request("http://localhost/api/skill-usage/e1/feedback", {
        method: "POST",
        body: JSON.stringify({ outcome: "meh" }),
      }),
      makeCtx("e1"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const res = await POST(
      new Request("http://localhost/api/skill-usage/e1/feedback", {
        method: "POST",
        body: "not json",
      }),
      makeCtx("e1"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when event not found (null result)", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    mockApplySkillFeedback.mockResolvedValue(null);
    const res = await POST(
      new Request("http://localhost/api/skill-usage/e1/feedback", {
        method: "POST",
        body: JSON.stringify({ outcome: "helpful" }),
      }),
      makeCtx("e1"),
    );
    expect(res.status).toBe(404);
    expect(mockApplySkillFeedback).toHaveBeenCalledWith({
      usageEventId: "e1",
      userId: "u1",
      outcome: "helpful",
    });
  });

  it("returns 200 with feedback result on success", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    mockApplySkillFeedback.mockResolvedValue({
      eventId: "e1",
      outcome: "not_helpful",
      skillId: "s1",
      successCount: 2,
      failureCount: 3,
      skillStatus: "active",
      shouldAttemptEvolution: true,
    });
    const res = await POST(
      new Request("http://localhost/api/skill-usage/e1/feedback", {
        method: "POST",
        body: JSON.stringify({ outcome: "not_helpful" }),
      }),
      makeCtx("e1"),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      id: "e1",
      outcome: "not_helpful",
      skill: { id: "s1", successCount: 2, failureCount: 3 },
      evolutionTriggered: false,
    });
  });
});
