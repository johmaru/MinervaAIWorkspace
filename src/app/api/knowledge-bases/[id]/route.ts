import { getSessionUser } from "@/lib/auth-guards";
import { deleteKnowledgeBase } from "@/lib/kbStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * DELETE /api/knowledge-bases/[id] — Delete a knowledge base.
 * Cascades to kb_documents and kb_chunks.
 */
export async function DELETE(req: Request, { params }: Params) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;

  const deleted = await deleteKnowledgeBase(id, user.id);
  if (!deleted) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 204 });
}
