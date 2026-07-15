import { desc, eq, and } from "drizzle-orm";
import { db } from "@/db";
import { connections } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/connections — List the logged-in user's connections (by update order).
 * Does not return accessToken / refreshToken (prevent secret leakage).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const rows = await db
    .select({
      id: connections.id,
      provider: connections.provider,
      workspaceName: connections.workspaceName,
      workspaceIcon: connections.workspaceIcon,
      ownerName: connections.ownerName,
      ownerEmail: connections.ownerEmail,
      createdAt: connections.createdAt,
      updatedAt: connections.updatedAt,
    })
    .from(connections)
    .where(eq(connections.userId, user.id))
    .orderBy(desc(connections.updatedAt)).limit(100);
  return Response.json(rows);
}

type DeleteBody = { id?: string };

/**
 * DELETE /api/connections — Delete a connection.
 * body: { id: string }
 * Only deletes rows owned by the user (cannot touch other users' rows).
 */
export async function DELETE(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  let body: DeleteBody = {};
  try {
    body = (await req.json()) as DeleteBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!body.id) return new Response("id is required", { status: 400 });
  await db
    .delete(connections)
    .where(and(eq(connections.id, body.id), eq(connections.userId, user.id)));
  return new Response(null, { status: 204 });
}
