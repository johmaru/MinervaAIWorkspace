// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock getSessionUser (for 401/400 tests that don't require auth).
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn(),
}));

// embedText is called in POST but not reached in validation error tests.
vi.mock("@/lib/embed", () => ({
  embedText: vi.fn(),
  hashContent: vi.fn(),
}));

// db is not used, but mock to avoid side effects on import.
vi.mock("@/db", () => ({ db: {} }));

import { getSessionUser } from "@/lib/auth-guards";
import { GET, POST } from "@/app/api/memories/route";

const mockGetSessionUser = vi.mocked(getSessionUser);

beforeEach(() => {
  mockGetSessionUser.mockReset();
});

function jsonReq(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/memories", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("GET /api/memories", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });
});

describe("POST /api/memories", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await POST(jsonReq("POST", { content: "x", threadId: "t1" }));
    expect(res.status).toBe(401);
  });

  it("content is required → 400", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const res = await POST(jsonReq("POST", { threadId: "t1" }));
    expect(res.status).toBe(400);
  });

  it("threadId is required → 400", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const res = await POST(jsonReq("POST", { content: "test memory" }));
    expect(res.status).toBe(400);
  });

  it("invalid JSON returns 400", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const req = new Request("http://localhost/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
