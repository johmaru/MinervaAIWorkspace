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
import { DELETE, PATCH } from "@/app/api/memories/[id]/route";

const mockGetSessionUser = vi.mocked(getSessionUser);

beforeEach(() => {
  mockGetSessionUser.mockReset();
});

function makeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("DELETE /api/memories/[id]", () => {
  it("未認証は 401", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await DELETE(new Request("http://localhost"), makeCtx("m1"));
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/memories/[id]", () => {
  it("未認証は 401", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "x" }),
      }),
      makeCtx("m1"),
    );
    expect(res.status).toBe(401);
  });
});
