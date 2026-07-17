import { db } from "@/db";
import { connections } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { exchangeOutlookCode, expiryFromExpiresIn } from "@/lib/connections/outlook";
import { resolvePublicOrigin } from "@/lib/request-origin";
import { getConfiguredAuthUrl } from "@/lib/auth-env";
import { logger } from "@/lib/logger";
import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return redirect("/login");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return redirect("/?connection_error=outlook_denied");
  if (!code || !state || state !== user.id) {
    return new Response("Invalid OAuth state", { status: 400 });
  }

  const origin = resolvePublicOrigin(req.headers, getConfiguredAuthUrl());
  const redirectUri = `${origin}/api/connections/outlook/callback`;

  try {
    const tokenResponse = await exchangeOutlookCode(code, redirectUri);
    await db.insert(connections).values({
      userId: user.id,
      provider: "outlook",
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? null,
      scopes: tokenResponse.scope,
      expiresAt: expiryFromExpiresIn(tokenResponse.expires_in),
      workspaceName: "Outlook",
      workspaceIcon: null,
      ownerName: tokenResponse.user.displayName,
      ownerEmail: tokenResponse.user.mail ?? tokenResponse.user.userPrincipalName,
      botId: tokenResponse.user.id,
    });
    return redirect("/?connection_success=outlook");
  } catch (err) {
    logger.error("connections", "Outlook OAuth callback failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return redirect("/?connection_error=outlook_failed");
  }
}
