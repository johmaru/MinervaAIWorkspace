import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { globalInstructions } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/global-instructions — Named global system instructions
 * of the logged-in user (newest first). Includes content.
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
    .orderBy(desc(globalInstructions.updatedAt)).limit(100);
  return Response.json(rows);
}

type CreateBody = {
  name?: string;
  content?: string;
};

/**
 * POST /api/global-instructions — Create a new named global instruction.
 * Duplicate names are allowed (users can explicitly create multiple). Empty name/content are rejected.
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
