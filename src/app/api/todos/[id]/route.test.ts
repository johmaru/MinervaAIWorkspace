// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock getSessionUser
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn(),
}));

// Mock the store layer — use vi.hoisted so the mock factory can reference the fns.
const { mockGetTodo, mockUpdateTodo, mockDeleteTodo } = vi.hoisted(() => ({
  mockGetTodo: vi.fn(),
  mockUpdateTodo: vi.fn(),
  mockDeleteTodo: vi.fn(),
}));

vi.mock("@/lib/todoStore", () => ({
  getTodo: mockGetTodo,
  updateTodo: mockUpdateTodo,
  deleteTodo: mockDeleteTodo,
}));

import { getSessionUser } from "@/lib/auth-guards";
import { GET, PATCH, DELETE } from "@/app/api/todos/[id]/route";

const mockGetSessionUser = vi.mocked(getSessionUser);

beforeEach(() => {
  mockGetSessionUser.mockReset();
  mockGetTodo.mockReset();
  mockUpdateTodo.mockReset();
  mockDeleteTodo.mockReset();
});

function makeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/todos/[id]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost"), makeCtx("t1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when todo not found", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    mockGetTodo.mockResolvedValue(undefined);
    const res = await GET(new Request("http://localhost"), makeCtx("t1"));
    expect(res.status).toBe(404);
  });

  it("returns the todo with embedding stripped", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    mockGetTodo.mockResolvedValue({
      id: "t1",
      title: "Test",
      description: null,
      status: "pending",
      priority: "medium",
      embedding: [0.1],
      contentHash: "h",
      model: "m",
    });
    const res = await GET(new Request("http://localhost"), makeCtx("t1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe("t1");
    expect(data.embedding).toBeUndefined();
  });
});

describe("PATCH /api/todos/[id]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await PATCH(
      new Request("http://localhost", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" }),
      makeCtx("t1"),
    );
    expect(res.status).toBe(401);
  });

  it("updates the todo and returns 200", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    mockUpdateTodo.mockResolvedValue({
      id: "t1",
      title: "Updated",
      description: null,
      status: "completed",
      priority: "high",
      embedding: [0.1],
      contentHash: "h",
      model: "m",
    });
    const res = await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed", priority: "high" }),
      }),
      makeCtx("t1"),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("completed");
    expect(data.embedding).toBeUndefined();
  });

  it("returns 404 when todo not found", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    mockUpdateTodo.mockResolvedValue(undefined);
    const res = await PATCH(
      new Request("http://localhost", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      }),
      makeCtx("t1"),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/todos/[id]", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await DELETE(new Request("http://localhost"), makeCtx("t1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when todo not found", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    mockGetTodo.mockResolvedValue(undefined);
    const res = await DELETE(new Request("http://localhost"), makeCtx("t1"));
    expect(res.status).toBe(404);
  });

  it("deletes the todo and returns 204", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    mockGetTodo.mockResolvedValue({ id: "t1" });
    mockDeleteTodo.mockResolvedValue(undefined);
    const res = await DELETE(new Request("http://localhost"), makeCtx("t1"));
    expect(res.status).toBe(204);
  });
});
