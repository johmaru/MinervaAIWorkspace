// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn(),
}));

const selectChain = {
  from: vi.fn().mockReturnThis(),
  leftJoin: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
};

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => selectChain),
  },
}));

import { getSessionUser } from "@/lib/auth-guards";
import { db } from "@/db";
import { GET } from "@/app/api/skill-evolution-proposals/route";

const mockGetSessionUser = vi.mocked(getSessionUser);
const mockDbSelect = vi.mocked(db.select);

beforeEach(() => {
  mockGetSessionUser.mockReset();
  mockDbSelect.mockClear();
  selectChain.from.mockClear();
  selectChain.leftJoin.mockClear();
  selectChain.where.mockClear();
  selectChain.orderBy.mockClear();
  selectChain.limit.mockClear();
  selectChain.limit.mockResolvedValue([]);
});

describe("GET /api/skill-evolution-proposals", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/api/skill-evolution-proposals"));
    expect(res.status).toBe(401);
  });

  it("invalid status parameter falls back to draft", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const res = await GET(new Request("http://localhost/api/skill-evolution-proposals?status=invalid"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
