// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

// getSessionUser をモック（認証不要な 401/400 テスト用）。
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn(),
}));

// embedText は POST で呼ばれるが、バリデーションエラーテストでは到達しない。
vi.mock("@/lib/embed", () => ({
  embedText: vi.fn(),
  hashContent: vi.fn(),
}));

// db は使用しないが import 時の副作用を回避。
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
  it("未認証は 401", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });
});

describe("POST /api/memories", () => {
  it("未認証は 401", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await POST(jsonReq("POST", { content: "x", threadId: "t1" }));
    expect(res.status).toBe(401);
  });

  it("content 必須 → 400", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const res = await POST(jsonReq("POST", { threadId: "t1" }));
    expect(res.status).toBe(400);
  });

  it("threadId 必須 → 400", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const res = await POST(jsonReq("POST", { content: "test memory" }));
    expect(res.status).toBe(400);
  });

  it("不正 JSON は 400", async () => {
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
