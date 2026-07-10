import { eq, and, desc, isNull } from "drizzle-orm";
import { db } from "@/db";
import { userTraits } from "@/db/schema";
import type { TraitCategory } from "@/lib/memory";

/**
 * Trait retrieval — always-injected user profile traits.
 *
 * Unlike memories, traits are not similarity-searched. All active traits
 * (up to 30) are injected into every conversation turn, ordered by
 * confidence DESC, updatedAt DESC.
 *
 * Embeddings on user_traits are used only for dedup and contradiction
 * candidate selection during extraction (see processProfileTraits in memory.ts).
 */

export type ProfileTrait = {
  id: string;
  category: TraitCategory;
  content: string;
  confidence: number;
  evidenceCount: number;
  updatedAt: Date;
};

/**
 * Fetches all active profile traits for a user.
 * Active = suppressedAt IS NULL.
 * Ordered by confidence DESC, updatedAt DESC, limited to 30 rows.
 */
export async function findProfileTraits(
  userId: string,
  limit = 30,
): Promise<ProfileTrait[]> {
  const rows = await db
    .select({
      id: userTraits.id,
      category: userTraits.category,
      content: userTraits.content,
      confidence: userTraits.confidence,
      evidenceCount: userTraits.evidenceCount,
      updatedAt: userTraits.updatedAt,
    })
    .from(userTraits)
    .where(
      and(
        eq(userTraits.userId, userId),
        isNull(userTraits.suppressedAt),
      ),
    )
    .orderBy(desc(userTraits.confidence), desc(userTraits.updatedAt))
    .limit(limit);

  return rows as ProfileTrait[];
}
