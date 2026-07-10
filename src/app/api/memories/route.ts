import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { memories, threads } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { embedText, hashContent } from "@/lib/embed";
import { activeMemoryConditions } from "@/lib/memoryUtils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/memories — All memories of the logged-in user (newest first).
 * Returns only those where suppressedAt IS NULL (not soft-deleted).
 * Excludes embedding; returns metadata + threadTitle only.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const rows = await db
    .select({
      id: memories.id,
      threadId: memories.threadId,
      threadTitle: threads.title,
      folderId: memories.folderId,
      kind: memories.kind,
      content: memories.content,
      importance: memories.importance,
      injectionCount: memories.injectionCount,
      lastInjectedAt: memories.lastInjectedAt,
      lastReferencedAt: memories.lastReferencedAt,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .innerJoin(threads, eq(memories.threadId, threads.id))
    .where(and(eq(threads.userId, user.id), ...activeMemoryConditions()))
    .orderBy(desc(memories.updatedAt));
  return Response.json(rows);
}

type CreateBody = {
  content?: string;
  kind?: "fact" | "working";
  importance?: number;
  threadId?: string;
};

/**
 * POST /api/memories — Manual memory creation.
 * Accepts content + threadId, generates embedding + contentHash, and saves.
 * Verifies thread ownership; cannot add to another user's thread.
 * No duplicate check (manual additions allow identical content in different contexts).
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  let body: CreateBody = {};
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const content = body.content?.trim();
  if (!content) return new Response("content is required", { status: 400 });
  if (!body.threadId) return new Response("threadId is required", { status: 400 });
  const kind = body.kind === "working" ? "working" : "fact";
  const importance =
    typeof body.importance === "number" ? Math.max(0, Math.min(1, body.importance)) : 0.5;

  // Verify thread ownership
  const [thread] = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, body.threadId), eq(threads.userId, user.id)))
    .limit(1);
  if (!thread) return new Response("thread not found", { status: 400 });

  const vector = await embedText(content, "document");
  if (vector.length === 0) return new Response("Embedding failed", { status: 503 });
  const contentHash = hashContent(content);

  const [row] = await db
    .insert(memories)
    .values({
      threadId: body.threadId,
      folderId: null,
      kind,
      content,
      embedding: vector,
      contentHash,
      model: "manual",
      importance,
      validFrom: new Date(),
      expiresAt: kind === "working" ? new Date(Date.now() + 7 * 86_400_000) : null,
    })
    .returning({
      id: memories.id,
      threadId: memories.threadId,
      kind: memories.kind,
      content: memories.content,
      importance: memories.importance,
    });
  return Response.json(row, { status: 201 });
}
