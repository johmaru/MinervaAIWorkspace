import { isNull, or, sql } from "drizzle-orm";
import { memories } from "@/db/schema";

/**
 * Active memory filter: a memory is "active" (eligible for RAG search/injection) when:
 *   1. suppressedAt IS NULL  — not user-soft-deleted
 *   2. validUntil IS NULL OR validUntil > now  — not superseded (replaced)
 *   3. expiresAt IS NULL OR expiresAt > now  — not auto-expired (working memory TTL)
 *
 * Returns a Drizzle condition array that can be spread into `.where(and(...conditions))`.
 * Usage:
 *   const conditions = [...activeMemoryConditions(), eq(threads.userId, user.id)];
 *   await db.select(...).from(memories).innerJoin(...).where(and(...conditions));
 */
export function activeMemoryConditions(now: Date = new Date()) {
  const nowMs = now.getTime();
  return [
    isNull(memories.suppressedAt),
    or(isNull(memories.validUntil), sql`${memories.validUntil} > ${nowMs}`),
    or(isNull(memories.expiresAt), sql`${memories.expiresAt} > ${nowMs}`),
  ];
}
