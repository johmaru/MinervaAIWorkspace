import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { globalInstructions } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/global-instructions — ログインユーザーの名前付きグローバル
 * システムインストラクション一覧（更新順）。content も返す。
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const rows = await db
    .select({
      id: globalInstructions.id,
      name: globalInstructions.name,
      content: globalInstructions.content,
      createdAt: globalInstructions.createdAt,
      updatedAt: globalInstructions.updatedAt,
    })
    .from(globalInstructions)
    .where(eq(globalInstructions.userId, user.id))
    .orderBy(desc(globalInstructions.updatedAt));
  return Response.json(rows);
}

type CreateBody = {
  name?: string;
  content?: string;
};

/**
 * POST /api/global-instructions — 名前付きグローバルインストラクション新規作成。
 * 同名も許容（ユーザーが明示的に複数作れる）。空名/空内容は却下。
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

  const [row] = await db
    .insert(globalInstructions)
    .values({ userId: user.id, name, content })
    .returning({
      id: globalInstructions.id,
      name: globalInstructions.name,
      content: globalInstructions.content,
    });
  return Response.json(row, { status: 201 });
}
