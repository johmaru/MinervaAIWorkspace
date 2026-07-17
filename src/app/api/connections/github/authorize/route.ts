import { getSessionUser } from "@/lib/auth-guards";
import { resolvePublicOrigin } from "@/lib/request-origin";
import { getConfiguredAuthUrl } from "@/lib/auth-env";
import { buildGithubAuthorizeUrl } from "@/lib/connections/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/connections/github/authorize — Redirect to the GitHub OAuth authorization URL.
 * The link target for the "Connect GitHub" button.
 * Sets the user ID in state for CSRF prevention.
 *
 * The redirect URI uses the incoming request origin (via resolvePublicOrigin)
 * so GitHub redirects back to the same host the user accessed from.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const clientId = process.env.GITHUB_CONNECTIONS_CLIENT_ID;
  if (!clientId) return new Response("GITHUB_CONNECTIONS_CLIENT_ID is not set", { status: 500 });

  const origin = resolvePublicOrigin(req.headers, getConfiguredAuthUrl());
  const redirectUri = `${origin}/api/connections/github/callback`;
  const state = user.id;
  const authUrl = buildGithubAuthorizeUrl(clientId, redirectUri, state);
  return Response.redirect(authUrl);
}
