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
import { GET, POST } from "@/app/api/skills/route";

const mockGetSessionUser = vi.mocked(getSessionUser);
const mockEmbedText = vi.mocked(embedText);
const mockHashContent = vi.mocked(hashContent);

beforeEach(() => {
  mockGetSessionUser.mockReset();
  mockEmbedText.mockReset();
  mockHashContent.mockReset();
});

function jsonReq(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/skills", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("GET /api/skills", () => {
  it("未認証は 401", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });
});

describe("POST /api/skills", () => {
  it("未認証は 401", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await POST(jsonReq("POST", { name: "x", content: "y" }));
    expect(res.status).toBe(401);
  });

  it("name 必須 → 400", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const res = await POST(jsonReq("POST", { content: "y" }));
    expect(res.status).toBe(400);
  });

  it("content 必須 → 400", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const res = await POST(jsonReq("POST", { name: "x" }));
    expect(res.status).toBe(400);
  });

  it("不正 JSON は 400", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const res = await POST(
      new Request("http://localhost/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("embedding source に name + trigger + tags + content を含む", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    mockEmbedText.mockResolvedValue([0.1, 0.2, 0.3]);
    mockHashContent.mockReturnValue("hash123");
    const { db } = await import("@/db");
    (db as { select: unknown }).select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    (db as { insert: unknown }).insert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "s1", name: "n", content: "c" }]),
      }),
    });

    const res = await POST(
      jsonReq("POST", {
        name: "Test Skill",
        content: "Do the thing.",
        kind: "bugfix",
        trigger: "when testing",
        tags: ["t1", "t2"],
      }),
    );

    expect(res.status).toBe(201);
    const embedArg = mockEmbedText.mock.calls[0]?.[0] as string;
    expect(embedArg).toContain("Test Skill");
    expect(embedArg).toContain("when testing");
    expect(embedArg).toContain("t1, t2");
    expect(embedArg).toContain("Do the thing.");
  });
});
