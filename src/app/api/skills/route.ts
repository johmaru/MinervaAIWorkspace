import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { skills } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { embedText, hashContent } from "@/lib/embed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/skills — ログインユーザーのスキル一覧（更新順）。
 * embedding は含まず、メタのみ返す。
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const rows = await db
    .select({
      id: skills.id,
      name: skills.name,
      content: skills.content,
      createdAt: skills.createdAt,
      updatedAt: skills.updatedAt,
    })
    .from(skills)
    .where(eq(skills.userId, user.id))
    .orderBy(desc(skills.updatedAt));
  return Response.json(rows);
}

type CreateBody = {
  name?: string;
  content?: string;
};

/**
 * POST /api/skills — スキル手動作成。
 * name + content を受け取り、embedding + contentHash を生成して保存。
 * contentHash が既存と一致する場合は 409 Conflict。
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
  const name = body.name?.trim();
  const content = body.content?.trim();
  if (!name || !content) {
    return new Response("name and content are required", { status: 400 });
  }

  const vector = await embedText(content, "document");
  if (vector.length === 0) {
    return new Response("Embedding failed", { status: 503 });
  }
  const contentHash = hashContent(content);

  const [dup] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.userId, user.id), eq(skills.contentHash, contentHash)))
    .limit(1);
  if (dup) return new Response("Skill already exists", { status: 409 });

  const [row] = await db
    .insert(skills)
    .values({ userId: user.id, name, content, embedding: vector, contentHash })
    .returning({ id: skills.id, name: skills.name, content: skills.content });
  return Response.json(row, { status: 201 });
}
