import { getSessionUser } from "@/lib/auth-guards";
import { listKnowledgeBases, createKnowledgeBase, deleteKnowledgeBase } from "@/lib/kbStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/knowledge-bases — List the logged-in user's knowledge bases.
 * Returns metadata + document count per KB.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const kbs = await listKnowledgeBases(user.id);
  return Response.json(kbs);
}

type CreateBody = {
  name?: string;
  description?: string;
};

/**
 * POST /api/knowledge-bases — Create a new knowledge base.
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
  if (!name) return new Response("name is required", { status: 400 });
  const description = body.description?.trim() || undefined;

  const kb = await createKnowledgeBase(user.id, name, description);
  return Response.json(kb, { status: 201 });
}
