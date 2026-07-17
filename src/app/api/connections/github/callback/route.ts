import { db } from "@/db";
import { connections } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { exchangeGithubCode } from "@/lib/connections/github";
import { resolvePublicOrigin } from "@/lib/request-origin";
import { getConfiguredAuthUrl } from "@/lib/auth-env";
import { logger } from "@/lib/logger";
import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/connections/github/callback — GitHub OAuth callback.
 *
 * GitHub redirects with ?code=...&state=...
 * state encodes the user ID for CSRF prevention.
 * Exchanges the code for a token + fetches user profile, saves to connections table.
 *
 * GitHub OAuth App tokens don't expire, so no refreshToken/expiresAt is stored.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return redirect("/login");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // User denied authorization on the GitHub side
  if (error) return redirect("/?connection_error=github_denied");

  // CSRF check: state must match the logged-in user ID
  if (!code || !state || state !== user.id) {
    return new Response("Invalid OAuth state", { status: 400 });
  }

  const origin = resolvePublicOrigin(req.headers, getConfiguredAuthUrl());
  const redirectUri = `${origin}/api/connections/github/callback`;

  try {
    const tokenResponse = await exchangeGithubCode(code, redirectUri);
    await db.insert(connections).values({
      userId: user.id,
      provider: "github",
      accessToken: tokenResponse.access_token,
      refreshToken: null,
      scopes: tokenResponse.scope,
      expiresAt: null,
      workspaceName: tokenResponse.user.login,
      workspaceIcon: tokenResponse.user.avatar_url,
      ownerName: tokenResponse.user.name ?? tokenResponse.user.login,
      ownerEmail: tokenResponse.user.email,
      botId: String(tokenResponse.user.id),
    });
    return redirect("/?connection_success=github");
  } catch (err) {
    logger.error("connections", "GitHub OAuth callback failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return redirect("/?connection_error=github_failed");
  }
}
