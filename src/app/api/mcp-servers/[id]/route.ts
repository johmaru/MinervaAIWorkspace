import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { mcpServers } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { validateMcpStdioCommand } from "@/lib/mcpClient";
import { assertMcpRemoteUrl, normalizeMcpHeaders } from "@/lib/mcpUrlGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PatchBody = {
  name?: string;
  transport?: "http" | "sse" | "stdio";
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  headers?: Record<string, string> | null;
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
 * name, transport, url, command, args, env, headers can be updated individually.
 * When transport changes to stdio, headers is forced null and url/command validated.
 * When transport changes to http/sse, url is SSRF-guarded and headers normalized.
 * Never returns raw headers — only hasHeaders.
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

  // Fetch current row to resolve transport when only url/headers are patched.
  const [existing] = await db
    .select({ transport: mcpServers.transport })
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, user.id)));
  if (!existing) return new Response("Not found", { status: 404 });

  const transport = body.transport ?? existing.transport;
  const isRemote = transport === "http" || transport === "sse";

  const values: Partial<typeof mcpServers.$inferInsert> = { updatedAt: new Date() };
  if (typeof body.name === "string") values.name = body.name.trim();
  if (body.transport !== undefined) values.transport = body.transport;

  if (body.url !== undefined) {
    if (isRemote) {
      if (body.url && body.url.trim()) {
        const urlCheck = assertMcpRemoteUrl(body.url.trim());
        if (!urlCheck.ok) {
          return new Response(`Invalid URL: ${urlCheck.reason}`, { status: 400 });
        }
        values.url = body.url.trim();
      } else {
        return new Response(`url is required for ${transport} transport`, { status: 400 });
      }
    } else {
      // stdio: clear url
      values.url = null;
    }
  }

  if (body.command !== undefined) {
    if (transport === "stdio") {
      if (body.command && body.command.trim()) {
        const validation = validateMcpStdioCommand(body.command.trim(), body.args ?? []);
        if (!validation.allowed) {
          return new Response(`Invalid command: ${validation.reason}`, { status: 400 });
        }
      }
      values.command = body.command;
    } else {
      // remote: clear command
      values.command = null;
    }
  }
  if (body.args !== undefined) values.args = transport === "stdio" ? body.args : null;
  if (body.env !== undefined) values.env = transport === "stdio" ? body.env : null;

  if (body.headers !== undefined) {
    if (isRemote) {
      try {
        values.headers = normalizeMcpHeaders(body.headers);
      } catch (err) {
        return new Response(err instanceof Error ? err.message : "invalid headers", { status: 400 });
      }
    } else {
      // stdio: headers must be null
      values.headers = null;
    }
  }

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
      headers: mcpServers.headers,
    });
  if (!row) return new Response("Not found", { status: 404 });
  // Never return raw headers — only hasHeaders boolean.
  const { headers, ...safe } = row;
  return Response.json({
    ...safe,
    hasHeaders: !!(headers && Object.keys(headers).length > 0),
  });
}
