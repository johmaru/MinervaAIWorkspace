import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mcpServers } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { validateMcpStdioCommand } from "@/lib/mcpClient";

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
 * DELETE /api/mcp-servers/[id] — Delete an MCP server.
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
 * PATCH /api/mcp-servers/[id] — Partial update of an MCP server.
 * name, url, command, args, env can be updated individually.
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
  if (body.command !== undefined) {
    if (body.command && body.command.trim()) {
      const validation = validateMcpStdioCommand(body.command.trim(), body.args ?? []);
      if (!validation.allowed) {
        return new Response(`Invalid command: ${validation.reason}`, { status: 400 });
      }
    }
    values.command = body.command;
  }
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
