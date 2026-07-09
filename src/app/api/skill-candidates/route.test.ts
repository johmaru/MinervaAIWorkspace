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
import { GET } from "@/app/api/skill-candidates/route";

const mockGetSessionUser = vi.mocked(getSessionUser);

beforeEach(() => {
  mockGetSessionUser.mockReset();
});

describe("GET /api/skill-candidates", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/api/skill-candidates"));
    expect(res.status).toBe(401);
  });

  it("invalid status parameter falls back to draft", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const { db } = await import("@/db");
    (db as { select: unknown }).select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    const res = await GET(new Request("http://localhost/api/skill-candidates?status=invalid"));
    expect(res.status).toBe(200);
  });
});
