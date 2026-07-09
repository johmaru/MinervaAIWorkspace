import { getSessionUser } from "@/lib/auth-guards";
import { resolvePublicOrigin } from "@/lib/request-origin";
import { getConfiguredAuthUrl } from "@/lib/auth-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/connections/notion/authorize — Redirect to the Notion OAuth authorization URL.
 * The link target for the "Connect to Notion" button.
 * Sets the user ID in state for CSRF prevention.
 *
 * The redirect URI uses the incoming request origin (via resolvePublicOrigin)
 * so Notion redirects back to the same host the user accessed from (public or
 * local). The callback route must derive the same origin.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const clientId = process.env.NOTION_CLIENT_ID;
  if (!clientId) return new Response("NOTION_CLIENT_ID is not set", { status: 500 });

  const origin = resolvePublicOrigin(req.headers, getConfiguredAuthUrl());
  const redirectUri = `${origin}/api/connections/notion/callback`;
  const state = user.id;
  const authUrl = `https://api.notion.com/v1/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&owner=user&state=${state}`;
  return Response.redirect(authUrl);
}
