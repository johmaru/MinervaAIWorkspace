import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { mcpServers } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { validateMcpStdioCommand } from "@/lib/mcpClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/mcp-servers — MCP servers of the logged-in user (newest first).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const rows = await db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      transport: mcpServers.transport,
      url: mcpServers.url,
      command: mcpServers.command,
      args: mcpServers.args,
      env: mcpServers.env,
      createdAt: mcpServers.createdAt,
      updatedAt: mcpServers.updatedAt,
    })
    .from(mcpServers)
    .where(eq(mcpServers.userId, user.id))
    .orderBy(desc(mcpServers.updatedAt));
  return Response.json(rows);
}

type CreateBody = {
  name?: string;
  transport?: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

/**
 * POST /api/mcp-servers — Register an MCP server.
 * transport="http" requires url.
 * transport="stdio" requires command.
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
  const transport = body.transport;
  if (!name) return new Response("name is required", { status: 400 });
  if (transport !== "http" && transport !== "stdio") {
    return new Response("transport must be 'http' or 'stdio'", { status: 400 });
  }

  if (transport === "http") {
    if (!body.url?.trim()) {
      return new Response("url is required for http transport", { status: 400 });
    }
  } else {
    if (!body.command?.trim()) {
      return new Response("command is required for stdio transport", { status: 400 });
    }
    const validation = validateMcpStdioCommand(body.command.trim(), body.args ?? []);
    if (!validation.allowed) {
      return new Response(`Invalid command: ${validation.reason}`, { status: 400 });
    }
  }

  const [row] = await db
    .insert(mcpServers)
    .values({
      userId: user.id,
      name,
      transport,
      url: transport === "http" ? body.url!.trim() : null,
      command: transport === "stdio" ? body.command!.trim() : null,
      args: transport === "stdio" ? (body.args ?? null) : null,
      env: transport === "stdio" ? (body.env ?? null) : null,
    })
    .returning({
      id: mcpServers.id,
      name: mcpServers.name,
      transport: mcpServers.transport,
      url: mcpServers.url,
      command: mcpServers.command,
      args: mcpServers.args,
      env: mcpServers.env,
    });
  return Response.json(row, { status: 201 });
}
