// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock getSessionUser (for 401 tests that don't require auth).
vi.mock("@/lib/auth-guards", () => ({
  getSessionUser: vi.fn(),
}));

// Mock the store layer — use vi.hoisted so the mock factory can reference the fns.
const { mockListTodos, mockCreateTodo } = vi.hoisted(() => ({
  mockListTodos: vi.fn(),
  mockCreateTodo: vi.fn(),
}));

vi.mock("@/lib/todoStore", () => ({
  listTodos: mockListTodos,
  createTodo: mockCreateTodo,
}));

import { getSessionUser } from "@/lib/auth-guards";
import { GET, POST } from "@/app/api/todos/route";

const mockGetSessionUser = vi.mocked(getSessionUser);

beforeEach(() => {
  mockGetSessionUser.mockReset();
  mockListTodos.mockReset();
  mockCreateTodo.mockReset();
});

function jsonReq(method: string, url: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("GET /api/todos", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/api/todos"));
    expect(res.status).toBe(401);
  });

  it("returns todos for the authenticated user", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    mockListTodos.mockResolvedValue([
      { id: "t1", title: "Test", embedding: [], contentHash: "h", model: "m" },
    ]);
    const res = await GET(new Request("http://localhost/api/todos"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("t1");
    // Embedding should be stripped
    expect(data[0].embedding).toBeUndefined();
    expect(data[0].contentHash).toBeUndefined();
    expect(data[0].model).toBeUndefined();
  });

  it("passes status filter to listTodos", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    mockListTodos.mockResolvedValue([]);
    await GET(new Request("http://localhost/api/todos?status=pending"));
    expect(mockListTodos).toHaveBeenCalledWith("u1", "pending");
  });
});

describe("POST /api/todos", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const res = await POST(jsonReq("POST", "/api/todos", { title: "Test" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when title is missing", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const res = await POST(jsonReq("POST", "/api/todos", {}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when title is empty", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const res = await POST(jsonReq("POST", "/api/todos", { title: "  " }));
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid JSON", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    const req = new Request("http://localhost/api/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("creates a todo and returns 201", async () => {
    mockGetSessionUser.mockResolvedValue({ id: "u1" });
    mockCreateTodo.mockResolvedValue({
      id: "t1",
      title: "Test todo",
      description: null,
      status: "pending",
      priority: "medium",
      embedding: [0.1],
      contentHash: "abc",
      model: "test-model",
      userId: "u1",
    });
    const res = await POST(jsonReq("POST", "/api/todos", { title: "Test todo" }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBe("t1");
    expect(data.title).toBe("Test todo");
    expect(data.status).toBe("pending");
    // Embedding should be stripped
    expect(data.embedding).toBeUndefined();
  });
});
