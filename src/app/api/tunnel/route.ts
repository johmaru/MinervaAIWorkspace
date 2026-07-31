/**
 * /api/tunnel — Cloudflare Tunnel start/stop/status.
 *
 * GET: Returns tunnel status (token is not returned in plaintext)
 * POST: Starts the tunnel using a token. If AUTH_URL is not set, prompts to save it to .env
 * DELETE: Stops the tunnel
 *
 * Design:
 *   - Token is not included in GET response (only hasToken indicates whether it is set)
 *   - AUTH_URL is saved to .env and mirrored to MINERVA_CONFIGURED_AUTH_URL (UI/OAuth base).
 *     Auth.js no longer reads AUTH_URL for request origin; dual local + Cloudflare
 *     access derives the origin from request headers (see src/lib/request-origin.ts).
 *   - Works in both Docker and exe environments (src/lib/tunnel.ts determines the environment)
 */
import { getSessionUser } from "@/lib/auth-guards";
import { getTunnelStatus, startTunnel, stopTunnel } from "@/lib/tunnel";
import { resolveEnvPath, updateEnvContent } from "@/lib/envUtils";
import { getConfiguredAuthUrl, setConfiguredAuthUrl } from "@/lib/auth-env";
import { readFileSync, writeFileSync } from "node:fs";
import { getRequestLocale, t } from "@/lib/i18n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tunnel — Returns tunnel status.
 *
 * Response:
 *   { running: boolean, hasToken: boolean, authUrl: string }
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const status = await getTunnelStatus();
  return Response.json(status);
}

type TunnelBody = {
  token?: string;
  authUrl?: string;
};

/**
 * POST /api/tunnel — Start the tunnel.
 *
 * body:
 *   token: Cloudflare Tunnel token (can be omitted if same as existing)
 *   authUrl: Public URL (e.g. https://minerva.example.com)
 *
 * Saves the token and AUTH_URL to .env, mirrors AUTH_URL to MINERVA_CONFIGURED_AUTH_URL
 * (UI/OAuth base), and deletes process.env.AUTH_URL so Auth.js derives the origin from
 * request headers (dual local + Cloudflare access, no restart needed).
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: TunnelBody;
  try {
    body = (await req.json()) as TunnelBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Token: if present in body use new value, otherwise use existing process.env
  const token = body.token || process.env.TUNNEL_TOKEN || "";
  if (!token) {
    return Response.json(
      { error: t(getRequestLocale(req), "settings.apiTunnelTokenMissing") },
      { status: 400 },
    );
  }

  // AUTH_URL: public hostname (read from configured mirror, not sticky AUTH_URL)
  const authUrl = body.authUrl || getConfiguredAuthUrl();
  if (!authUrl || !authUrl.startsWith("https://")) {
    return Response.json(
      { error: t(getRequestLocale(req), "settings.apiTunnelAuthUrlInvalid") },
      { status: 400 },
    );
  }

  // Save to .env (token + AUTH_URL)
  try {
    const envPath = resolveEnvPath();
    let envContent = "";
    try {
      envContent = readFileSync(envPath, "utf8");
    } catch {
      envContent = "";
    }
    const updates: Record<string, string> = {
      TUNNEL_TOKEN: token,
      AUTH_URL: authUrl,
    };
    envContent = updateEnvContent(envContent, updates);
    writeFileSync(envPath, envContent);

    // Reflect token in process.env; mirror AUTH_URL to MINERVA_CONFIGURED_AUTH_URL
    // and delete process.env.AUTH_URL so Auth.js uses request headers (dual access).
    process.env.TUNNEL_TOKEN = token;
    setConfiguredAuthUrl(authUrl);
  } catch (err) {
    return Response.json(
      {
        error: t(getRequestLocale(req), "settings.apiEnvSaveFailed", { error: err instanceof Error ? err.message : String(err) }),
      },
      { status: 500 },
    );
  }

  // Start cloudflared
  try {
    // force=true: if already running, stop and restart (to reliably reflect token changes)
    await startTunnel(token, { force: true });
  } catch (err) {
    return Response.json(
      {
        error: t(getRequestLocale(req), "settings.apiTunnelStartFailed", { error: err instanceof Error ? err.message : String(err) }),
      },
      { status: 500 },
    );
  }

  const status = await getTunnelStatus();
  return Response.json({ success: true, ...status });
}

/**
 * DELETE /api/tunnel — Stop the tunnel.
 */
export async function DELETE(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  try {
    await stopTunnel();
  } catch (err) {
    return Response.json(
      {
        error: t(getRequestLocale(req), "settings.apiTunnelStopFailed", { error: err instanceof Error ? err.message : String(err) }),
      },
      { status: 500 },
    );
  }

  const status = await getTunnelStatus();
  return Response.json({ success: true, ...status });
}
