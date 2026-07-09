import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { getRequestLocale, t } from "@/lib/i18n";
import { getSessionUser } from "@/lib/auth-guards";
import { resolveEnvPath, escapeEnvValue } from "@/lib/envUtils";

const execAsync = promisify(exec);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COMPOSE_DIR = process.cwd();
const SOCKS_PROXY = "socks5://tor:9050";

/**
 * GET /api/tor — Returns Tor proxy status + connection check.
 *
 * The Tor container is always running via docker-compose up.
 * running is determined by whether SCRAPE_PROXY is set (= communicating via Tor).
 *
 * Response:
 *   { running: boolean, scrapeProxy: string, torProxy: string, connection: {...} }
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const scrapeProxy = process.env.SCRAPE_PROXY || "";
  const torProxy = process.env.TOR_PROXY || "";
  // Tor container is always running. running is determined by whether SCRAPE_PROXY is set.
  const running = scrapeProxy === SOCKS_PROXY;

  // Actual Tor connection check: calls scraper's /tor-check
  // Compares direct IP and Tor-routed IP to verify Tor is actually working
  let connection: { directIp: string | null; torIp: string | null; connected: boolean; error: string | null } = {
    directIp: null,
    torIp: null,
    connected: false,
    error: null,
  };
  if (running) {
    try {
      const scraperUrl = process.env.SCRAPER_URL || "http://localhost:8000";
      const res = await fetch(`${scraperUrl}/tor-check`, { signal: AbortSignal.timeout(45_000) });
      if (res.ok) {
        connection = (await res.json()) as typeof connection;
      } else {
        connection.error = `scraper /tor-check returned ${res.status}`;
      }
    } catch (err) {
      connection.error = err instanceof Error ? err.message : "Connection check failed";
    }
  }

  return Response.json({
    running,
    scrapeProxy,
    torProxy,
    socksProxy: SOCKS_PROXY,
    connection,
  });
}

type TorBody = {
  action: "start" | "stop";
};

/**
 * POST /api/tor — Toggle Tor proxy on/off.
 *
 * The Tor container itself is always running via docker-compose up.
 * This API only rewrites SCRAPE_PROXY / TOR_PROXY in .env and restarts the scraper.
 *
 * action=start:  Set SCRAPE_PROXY / TOR_PROXY to socks5://tor:9050
 * action=stop:   Set SCRAPE_PROXY / TOR_PROXY to empty
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const locale = getRequestLocale(req);
  let body: TorBody;
  try {
    body = (await req.json()) as TorBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (body.action !== "start" && body.action !== "stop") {
    return new Response("action must be start or stop", { status: 400 });
  }

  const wantProxy = body.action === "start" ? SOCKS_PROXY : "";

  // Update SCRAPE_PROXY and TOR_PROXY in .env
  try {
    const envPath = resolveEnvPath();
    let envContent = "";
    try {
      envContent = readFileSync(envPath, "utf8");
    } catch {
      envContent = "";
    }

    const updates: Record<string, string> = {
      SCRAPE_PROXY: wantProxy,
      TOR_PROXY: wantProxy,
    };

    for (const [key, rawValue] of Object.entries(updates)) {
      const value = escapeEnvValue(rawValue);
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    }

    writeFileSync(envPath, envContent);
    process.env.SCRAPE_PROXY = wantProxy;
    process.env.TOR_PROXY = wantProxy;
  } catch (err) {
    return Response.json(
      { error: t(locale, "settings.apiEnvUpdateFail", { error: err instanceof Error ? err.message : String(err) }) },
      { status: 500 },
    );
  }

  // Restart the scraper container to reflect SCRAPE_PROXY changes
  try {
    await execAsync("docker compose restart scraper", {
      cwd: COMPOSE_DIR,
      timeout: 60_000,
    });
  } catch (err) {
    return Response.json(
      { error: t(locale, "settings.apiTorRestartScraperFail", { error: err instanceof Error ? err.message : String(err) }) },
      { status: 500 },
    );
  }

  return Response.json({
    success: true,
    running: body.action === "start",
    scrapeProxy: wantProxy,
    message:
      body.action === "start"
        ? t(locale, "settings.apiTorStarted")
        : t(locale, "settings.apiTorStopped"),
  });
}
