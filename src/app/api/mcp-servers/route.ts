import { desc, eq, count } from "drizzle-orm";
import { db } from "@/db";
import { mcpServers } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { validateMcpStdioCommand } from "@/lib/mcpClient";
import { assertMcpRemoteUrl, normalizeMcpHeaders } from "@/lib/mcpUrlGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/mcp-servers — MCP servers of the logged-in user (newest first).
 * Headers are never returned raw (secret). Only `hasHeaders: boolean` is exposed.
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
      headers: mcpServers.headers,
      createdAt: mcpServers.createdAt,
      updatedAt: mcpServers.updatedAt,
    })
    .from(mcpServers)
    .where(eq(mcpServers.userId, user.id))
    .orderBy(desc(mcpServers.updatedAt)).limit(100);
  // Mask headers: return hasHeaders boolean instead of raw secret values.
  const masked = rows.map(({ headers, ...rest }) => ({
    ...rest,
    hasHeaders: !!(headers && Object.keys(headers).length > 0),
  }));
  return Response.json(masked);
}

type CreateBody = {
  name?: string;
  transport?: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

/**
 * POST /api/mcp-servers — Register an MCP server.
 * transport="http"|"sse" requires url (SSRF-guarded).
 * transport="stdio" requires command.
 * headers (optional, http/sse only) — normalized, trimmed, max 20 entries.
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
  if (transport !== "http" && transport !== "sse" && transport !== "stdio") {
    return new Response("transport must be 'http', 'sse', or 'stdio'", { status: 400 });
  }

  // Limit: max 20 MCP servers per user to prevent resource exhaustion
  const [{ value: serverCount }] = await db
    .select({ value: count() })
    .from(mcpServers)
    .where(eq(mcpServers.userId, user.id));
  if (serverCount >= 20) {
    return new Response("Maximum number of MCP servers (20) reached", { status: 409 });
  }

  const isRemote = transport === "http" || transport === "sse";
  let normalizedHeaders: Record<string, string> | null = null;

  if (isRemote) {
    if (!body.url?.trim()) {
      return new Response(`url is required for ${transport} transport`, { status: 400 });
    }
    const urlCheck = assertMcpRemoteUrl(body.url.trim());
    if (!urlCheck.ok) {
      return new Response(`Invalid URL: ${urlCheck.reason}`, { status: 400 });
    }
    // Normalize headers; may throw on oversize.
    try {
      normalizedHeaders = normalizeMcpHeaders(body.headers ?? null);
    } catch (err) {
      return new Response(err instanceof Error ? err.message : "invalid headers", { status: 400 });
    }
  } else {
    // stdio
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
      url: isRemote ? body.url!.trim() : null,
      command: transport === "stdio" ? body.command!.trim() : null,
      args: transport === "stdio" ? (body.args ?? null) : null,
      env: transport === "stdio" ? (body.env ?? null) : null,
      // headers only for remote transports; stdio must be null.
      headers: isRemote ? normalizedHeaders : null,
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
  // Never return raw headers in the response — only hasHeaders.
  return Response.json({ ...row, hasHeaders: !!normalizedHeaders }, { status: 201 });
}
