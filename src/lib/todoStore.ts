import { eq, and, desc, asc, sql } from "drizzle-orm";
import { db } from "@/db";
import { todos } from "@/db/schema";
import { embedText, hashContent } from "@/lib/embed";
import { toVecBuffer } from "@/lib/vectorSearch";

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "low" | "medium" | "high";

/**
 * todos — per-user task items with vector embedding.
 * Store layer: CRUD + semantic search. All functions enforce userId isolation.
 */

/**
 * List all todos for a user, optionally filtered by status.
 * Ordered by dueAt asc (nulls last), then createdAt desc.
 */
export async function listTodos(userId: string, status?: TodoStatus) {
  const conditions = [eq(todos.userId, userId)];
  if (status) conditions.push(eq(todos.status, status));
  return db
    .select()
    .from(todos)
    .where(and(...conditions))
    .orderBy(sql`${todos.dueAt} IS NULL`, asc(todos.dueAt), desc(todos.createdAt));
}

/**
 * Get a single todo by id + userId (user isolation).
 */
export async function getTodo(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(todos)
    .where(and(eq(todos.id, id), eq(todos.userId, userId)))
    .limit(1);
  return row ?? undefined;
}

/**
 * Create a todo. Embeds the content, computes contentHash.
 * If embedText returns [] (model loading), still inserts with embedding: [].
 */
export async function createTodo(
  userId: string,
  data: {
    title: string;
    description?: string;
    priority?: TodoPriority;
    dueAt?: Date | null;
    threadId?: string | null;
  },
): Promise<typeof todos.$inferSelect> {
  if (!data.title.trim()) throw new Error("title is required");
  const embedContent = `${data.title}${data.description ? "\n" + data.description : ""}`;
  const embedding = await embedText(embedContent, "document");
  const contentHash = hashContent(embedContent);
  const model = process.env.EMBED_MODEL || "LiquidAI/LFM2.5-Embedding-350M";

  const [row] = await db
    .insert(todos)
    .values({
      userId,
      title: data.title.trim(),
      description: data.description ?? null,
      embedding,
      contentHash,
      model,
      priority: data.priority ?? "medium",
      dueAt: data.dueAt ?? null,
      threadId: data.threadId ?? null,
    })
    .returning();
  return row;
}

/**
 * Update a todo. Re-embeds if title or description changes.
 * If status transitions to "completed", sets completedAt = now.
 * If status transitions away from "completed", clears completedAt.
 */
export async function updateTodo(
  userId: string,
  id: string,
  data: {
    title?: string;
    description?: string;
    status?: TodoStatus;
    priority?: TodoPriority;
    dueAt?: Date | null;
  },
): Promise<typeof todos.$inferSelect | undefined> {
  const existing = await getTodo(userId, id);
  if (!existing) return undefined;

  const values: Partial<typeof todos.$inferInsert> = { updatedAt: new Date() };

  // Status transition logic
  if (data.status && data.status !== existing.status) {
    values.status = data.status;
    if (data.status === "completed") {
      values.completedAt = new Date();
    } else {
      values.completedAt = null;
    }
  }

  if (data.priority) values.priority = data.priority;

  if (data.dueAt !== undefined) values.dueAt = data.dueAt ?? null;

  // Re-embed if title or description changes
  const titleChanged = data.title !== undefined && data.title !== existing.title;
  const descChanged = data.description !== undefined && data.description !== existing.description;
  if (titleChanged || descChanged) {
    const newTitle = data.title !== undefined ? data.title.trim() : existing.title;
    const newDesc = data.description !== undefined ? data.description : existing.description;
    if (!newTitle) throw new Error("title is required");
    const embedContent = `${newTitle}${newDesc ? "\n" + newDesc : ""}`;
    const embedding = await embedText(embedContent, "document");
    values.title = newTitle;
    values.description = newDesc ?? null;
    values.embedding = embedding;
    values.contentHash = hashContent(embedContent);
    values.model = process.env.EMBED_MODEL || "LiquidAI/LFM2.5-Embedding-350M";
  }

  const [row] = await db
    .update(todos)
    .set(values)
    .where(and(eq(todos.id, id), eq(todos.userId, userId)))
    .returning();
  return row ?? undefined;
}

/**
 * Delete a todo (physical delete — todos are disposable).
 */
export async function deleteTodo(userId: string, id: string): Promise<void> {
  await db.delete(todos).where(and(eq(todos.id, id), eq(todos.userId, userId)));
}

/**
 * Semantic search: find todos matching a query string.
 * Embeds the query, uses vec_distance_cosine in SQL (similarity > 0.3 = distance < 0.7).
 * Returns [] if no todos or embedding fails.
 */
export async function searchTodos(userId: string, query: string, limit = 5) {
  let queryVec: number[];
  try {
    queryVec = await embedText(query, "query");
  } catch {
    return [];
  }
  if (queryVec.length === 0) return [];
  const queryBuf = toVecBuffer(queryVec);

  const rows = await db.all(sql`
    SELECT *
    FROM todos
    WHERE user_id = ${userId}
      AND vec_distance_cosine(embedding, ${queryBuf}) < 0.7
    ORDER BY vec_distance_cosine(embedding, ${queryBuf})
    LIMIT ${limit}
  `);

  return rows;
}
