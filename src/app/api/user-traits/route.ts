import { eq, and, desc, isNull } from "drizzle-orm";
import { db } from "@/db";
import { userTraits } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { embedText, hashContent } from "@/lib/embed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/user-traits — All active traits for the authenticated user.
 * Returns only those where suppressedAt IS NULL, ordered by confidence DESC, updatedAt DESC.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const rows = await db
    .select({
      id: userTraits.id,
      category: userTraits.category,
      content: userTraits.content,
      confidence: userTraits.confidence,
      evidenceCount: userTraits.evidenceCount,
      createdAt: userTraits.createdAt,
      updatedAt: userTraits.updatedAt,
    })
    .from(userTraits)
    .where(and(eq(userTraits.userId, user.id), isNull(userTraits.suppressedAt)))
    .orderBy(desc(userTraits.confidence), desc(userTraits.updatedAt));
  return Response.json(rows);
}

type CreateBody = {
  content?: string;
  category?: "demographic" | "interest" | "speech_pattern" | "preference";
};

/**
 * POST /api/user-traits — Manual trait creation.
 * User-authored traits get confidence = 1.0 (high trust), evidenceCount = 1.
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
  const validCategories = ["demographic", "interest", "speech_pattern", "preference"] as const;
  const category = body.category && validCategories.includes(body.category)
    ? body.category
    : "preference";

  const vector = await embedText(content, "document");
  if (vector.length === 0) return new Response("Embedding failed", { status: 503 });
  const contentHash = hashContent(content);
  const embedModel = process.env.EMBED_MODEL || "Xenova/all-MiniLM-L6-v2";

  const [row] = await db
    .insert(userTraits)
    .values({
      userId: user.id,
      category,
      content,
      embedding: vector,
      contentHash,
      model: embedModel,
      confidence: 1.0,
      evidenceCount: 1,
    })
    .returning({
      id: userTraits.id,
      category: userTraits.category,
      content: userTraits.content,
      confidence: userTraits.confidence,
      evidenceCount: userTraits.evidenceCount,
      createdAt: userTraits.createdAt,
      updatedAt: userTraits.updatedAt,
    });
  return Response.json(row, { status: 201 });
}
