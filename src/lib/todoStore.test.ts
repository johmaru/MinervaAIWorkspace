// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { todos, users } from "@/db/schema";

// Mock embedText: return deterministic vectors without depending on the real embedder service.
// Generates a 1024-dimensional pseudo-vector from the content hash, so identical content yields identical vectors.
vi.mock("@/lib/embed", () => ({
  embedText: vi.fn().mockImplementation(async (text: string) => {
    const vec = new Array(1024).fill(0);
    for (const ch of text) {
      const code = ch.charCodeAt(0) % 1024;
      vec[code] = 1;
    }
    return vec;
  }),
  hashContent: vi.fn().mockImplementation((text: string) => {
    return createHash("sha256").update(text).digest("hex");
  }),
}));

import { createTodo, getTodo, listTodos, updateTodo, deleteTodo, searchTodos } from "@/lib/todoStore";

const createdUserIds: string[] = [];
const createdTodoIds: string[] = [];
let testUserId: string;
let otherUserId: string;

beforeAll(async () => {
  const [u1] = await db.insert(users).values({
    nickname: "todoStore-test-user1",
    email: "todostore-test@minerva.test",
  }).returning();
  testUserId = u1.id;
  createdUserIds.push(u1.id);

  const [u2] = await db.insert(users).values({
    nickname: "todoStore-test-user2",
    email: "todostore-test-other@minerva.test",
  }).returning();
  otherUserId = u2.id;
  createdUserIds.push(u2.id);
});

afterAll(async () => {
  for (const id of createdTodoIds) {
    await db.delete(todos).where(eq(todos.id, id));
  }
  for (const id of createdUserIds) {
    await db.delete(todos).where(eq(todos.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("createTodo", () => {
  it("creates a todo with embedding, contentHash, and default status", async () => {
    const row = await createTodo(testUserId, { title: "Fix bug", description: "Critical issue" });
    createdTodoIds.push(row.id);

    expect(row.title).toBe("Fix bug");
    expect(row.description).toBe("Critical issue");
    expect(row.status).toBe("pending");
    expect(row.priority).toBe("medium");
    expect(row.embedding.length).toBeGreaterThan(0);
    expect(row.contentHash).toBeTruthy();
    expect(row.model).toBeTruthy();
    expect(row.userId).toBe(testUserId);
    expect(row.completedAt).toBeNull();
  });

  it("throws on empty title", async () => {
    await expect(createTodo(testUserId, { title: "" })).rejects.toThrow("title is required");
  });
});

describe("getTodo — userId isolation", () => {
  it("returns todo for correct user", async () => {
    const created = await createTodo(testUserId, { title: "Isolation test" });
    createdTodoIds.push(created.id);

    const row = await getTodo(testUserId, created.id);
    expect(row?.id).toBe(created.id);

    const other = await getTodo(otherUserId, created.id);
    expect(other).toBeUndefined();
  });
});

describe("listTodos", () => {
  it("lists only the user's todos", async () => {
    const t1 = await createTodo(testUserId, { title: "List test 1" });
    const t2 = await createTodo(testUserId, { title: "List test 2", priority: "high" });
    const t3 = await createTodo(otherUserId, { title: "Other user todo" });
    createdTodoIds.push(t1.id, t2.id, t3.id);

    const mine = await listTodos(testUserId);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine.every((t) => t.userId === testUserId)).toBe(true);
    expect(mine.some((t) => t.id === t1.id)).toBe(true);
    expect(mine.some((t) => t.id === t2.id)).toBe(true);
    expect(mine.some((t) => t.id === t3.id)).toBe(false);
  });

  it("filters by status", async () => {
    const t = await createTodo(testUserId, { title: "Status filter test" });
    createdTodoIds.push(t.id);

    await updateTodo(testUserId, t.id, { status: "completed" });

    const pending = await listTodos(testUserId, "pending");
    const completed = await listTodos(testUserId, "completed");

    expect(pending.some((todo) => todo.id === t.id)).toBe(false);
    expect(completed.some((todo) => todo.id === t.id)).toBe(true);
  });
});

describe("updateTodo", () => {
  it("sets completedAt when status → completed", async () => {
    const t = await createTodo(testUserId, { title: "Complete me" });
    createdTodoIds.push(t.id);

    const updated = await updateTodo(testUserId, t.id, { status: "completed" });
    expect(updated?.status).toBe("completed");
    expect(updated?.completedAt).toBeInstanceOf(Date);
  });

  it("clears completedAt when status ← pending", async () => {
    const t = await createTodo(testUserId, { title: "Reopen me" });
    createdTodoIds.push(t.id);

    await updateTodo(testUserId, t.id, { status: "completed" });
    const reopened = await updateTodo(testUserId, t.id, { status: "pending" });

    expect(reopened?.status).toBe("pending");
    expect(reopened?.completedAt).toBeNull();
  });

  it("re-embeds when title changes", async () => {
    const t = await createTodo(testUserId, { title: "Original title" });
    createdTodoIds.push(t.id);

    const updated = await updateTodo(testUserId, t.id, { title: "New title" });
    expect(updated?.title).toBe("New title");
    expect(updated?.contentHash).not.toBe(t.contentHash);
  });

  it("returns undefined for non-existent todo", async () => {
    const result = await updateTodo(testUserId, "nonexistent-id", { title: "x" });
    expect(result).toBeUndefined();
  });
});

describe("deleteTodo", () => {
  it("deletes the todo", async () => {
    const t = await createTodo(testUserId, { title: "Delete me" });
    await deleteTodo(testUserId, t.id);

    const row = await getTodo(testUserId, t.id);
    expect(row).toBeUndefined();
  });

  it("does not delete other user's todo", async () => {
    const t = await createTodo(testUserId, { title: "Protected" });
    createdTodoIds.push(t.id);

    await deleteTodo(otherUserId, t.id);
    const row = await getTodo(testUserId, t.id);
    expect(row).toBeDefined();
  });
});

describe("searchTodos", () => {
  it("returns todos matching the query with similarity > 0.3", async () => {
    const t = await createTodo(testUserId, { title: "Fix database migration bug", description: "SQLite schema issue" });
    createdTodoIds.push(t.id);

    const results = await searchTodos(testUserId, "database bug");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.id === t.id)).toBe(true);
  });

  it("returns [] when user has no todos", async () => {
    const results = await searchTodos("nonexistent-user-id", "anything");
    expect(results).toEqual([]);
  });
});
