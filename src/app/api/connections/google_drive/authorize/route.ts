import { getSessionUser } from "@/lib/auth-guards";
import { resolvePublicOrigin } from "@/lib/request-origin";
import { getConfiguredAuthUrl } from "@/lib/auth-env";
import { buildGoogleDriveAuthorizeUrl } from "@/lib/connections/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const clientId = process.env.GOOGLE_CONNECTIONS_CLIENT_ID;
  if (!clientId) return new Response("GOOGLE_CONNECTIONS_CLIENT_ID is not set", { status: 500 });

  const origin = resolvePublicOrigin(req.headers, getConfiguredAuthUrl());
  const redirectUri = `${origin}/api/connections/google_drive/callback`;
  const state = user.id;
  const authUrl = buildGoogleDriveAuthorizeUrl(clientId, redirectUri, state);
  return Response.redirect(authUrl);
}
