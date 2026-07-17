import { db } from "@/db";
import { mcpServers } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth-guards";
import {
  connectMcpServer,
  listMcpTools,
  validateMcpStdioCommand,
} from "@/lib/mcpClient";
import { assertMcpRemoteUrl, normalizeMcpHeaders } from "@/lib/mcpUrlGuard";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TestBody = {
  id?: string;
  name?: string;
  transport?: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

/** Upper bound on connection test so a hung SSE does not pin the request. */
const TEST_TIMEOUT_MS = 15_000;

/**
 * POST /api/mcp-servers/test — Probe a remote or stdio MCP server connection.
 *
 * Accepts the same body shape as POST /api/mcp-servers (id optional: when
 * provided, the saved row's headers are merged with the body for testing an
 * existing server). Runs connectMcpServer → listMcpTools → client.close().
 *
 * Response 200: { ok: true, transportUsed, tools: [{ name, description }] }
 * Soft failure 200: { ok: false, error: string } — no stack traces to client.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: TestBody;
  try {
    body = (await req.json()) as TestBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const transport = body.transport;
  if (transport !== "http" && transport !== "sse" && transport !== "stdio") {
    return Response.json({ ok: false, error: "transport must be 'http', 'sse', or 'stdio'" });
  }

  // When testing a saved server by id, load its headers (secrets) from DB
  // so the user does not have to re-enter them in the test form.
  let mergedHeaders = body.headers ?? null;
  if (body.id) {
    const [saved] = await db
      .select({ headers: mcpServers.headers, userId: mcpServers.userId })
      .from(mcpServers)
      .where(and(eq(mcpServers.id, body.id), eq(mcpServers.userId, user.id)));
    if (!saved) return Response.json({ ok: false, error: "server not found" });
    // Body headers take precedence; fall back to saved headers.
    mergedHeaders = body.headers ?? saved.headers ?? null;
  }

  const isRemote = transport === "http" || transport === "sse";

  // Normalize headers (remote only). stdio ignores headers.
  let normalizedHeaders: Record<string, string> | null = null;
  if (isRemote) {
    try {
      normalizedHeaders = normalizeMcpHeaders(mergedHeaders);
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : "invalid headers" });
    }
  }

  // Validate inputs before attempting connection.
  if (isRemote) {
    if (!body.url?.trim()) {
      return Response.json({ ok: false, error: `url is required for ${transport} transport` });
    }
    const urlCheck = assertMcpRemoteUrl(body.url.trim());
    if (!urlCheck.ok) {
      return Response.json({ ok: false, error: `Invalid URL: ${urlCheck.reason}` });
    }
  } else {
    if (!body.command?.trim()) {
      return Response.json({ ok: false, error: "command is required for stdio transport" });
    }
    const validation = validateMcpStdioCommand(body.command.trim(), body.args ?? []);
    if (!validation.allowed) {
      return Response.json({ ok: false, error: `Invalid command: ${validation.reason}` });
    }
  }

  const config = {
    id: body.id ?? "test",
    name: body.name?.trim() || "test-server",
    transport,
    url: isRemote ? body.url!.trim() : null,
    command: transport === "stdio" ? body.command!.trim() : null,
    args: transport === "stdio" ? (body.args ?? null) : null,
    env: transport === "stdio" ? (body.env ?? null) : null,
    headers: isRemote ? normalizedHeaders : null,
  };

  const conn = await Promise.race([
    connectMcpServer(config),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), TEST_TIMEOUT_MS)),
  ]);

  if (!conn) {
    return Response.json({ ok: false, error: "connection failed or timed out" });
  }

  try {
    const tools = await listMcpTools(conn);
    const toolList = tools.map((t) => ({ name: t.toolName, description: t.description }));
    return Response.json({
      ok: true,
      transportUsed: transport,
      tools: toolList,
    });
  } catch (err) {
    logger.warn("mcp-test", "listTools failed", { error: err instanceof Error ? err.message : String(err) });
    return Response.json({ ok: false, error: "connected but listTools failed" });
  } finally {
    try { await conn.client.close(); } catch { /* ignore */ }
  }
}
