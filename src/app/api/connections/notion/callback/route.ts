import { db } from "@/db";
import { connections } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { exchangeNotionCode } from "@/lib/connections/notion";
import { logger } from "@/lib/logger";
import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/connections/notion/callback — Notion OAuth callback.
 *
 * Notion redirects with ?code=...&state=...
 * state encodes the user ID for CSRF prevention.
 * Exchanges the code for a token, saves it to the connections table, and redirects to the root.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return redirect("/login");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // User denied authorization on the Notion side
  if (error) return redirect("/?connection_error=notion_denied");

  // CSRF check: state must match the logged-in user ID
  if (!code || !state || state !== user.id) {
    return new Response("Invalid OAuth state", { status: 400 });
  }

  const redirectUri = `${process.env.AUTH_URL ?? "http://localhost:3001"}/api/connections/notion/callback`;

  try {
    const tokenResponse = await exchangeNotionCode(code, redirectUri);
    await db.insert(connections).values({
      userId: user.id,
      provider: "notion",
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      workspaceName: tokenResponse.workspace_name,
      workspaceIcon: tokenResponse.workspace_icon,
      botId: tokenResponse.bot_id,
      ownerName: tokenResponse.owner?.user?.name ?? null,
      ownerEmail: tokenResponse.owner?.user?.email ?? null,
    });
    return redirect("/?connection_success=notion");
  } catch (err) {
    logger.error("connections", "Notion OAuth callback failed", { error: err instanceof Error ? err.message : String(err) });
    return redirect("/?connection_error=notion_failed");
  }
}
