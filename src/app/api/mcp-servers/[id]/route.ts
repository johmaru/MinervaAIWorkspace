import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mcpServers } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PatchBody = {
  name?: string;
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
};

/**
 * DELETE /api/mcp-servers/[id] — MCP サーバー削除。
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const [row] = await db
    .delete(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, user.id)))
    .returning();
  if (!row) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 204 });
}

/**
 * PATCH /api/mcp-servers/[id] — MCP サーバー部分更新。
 * name, url, command, args, env を個別に更新可能。
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const values: Partial<typeof mcpServers.$inferInsert> = { updatedAt: new Date() };
  if (typeof body.name === "string") values.name = body.name.trim();
  if (body.url !== undefined) values.url = body.url;
  if (body.command !== undefined) values.command = body.command;
  if (body.args !== undefined) values.args = body.args;
  if (body.env !== undefined) values.env = body.env;

  const [row] = await db
    .update(mcpServers)
    .set(values)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, user.id)))
    .returning({
      id: mcpServers.id,
      name: mcpServers.name,
      transport: mcpServers.transport,
      url: mcpServers.url,
      command: mcpServers.command,
      args: mcpServers.args,
      env: mcpServers.env,
    });
  if (!row) return new Response("Not found", { status: 404 });
  return Response.json(row);
}
