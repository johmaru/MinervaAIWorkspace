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
 * GET /api/tor — Tor プロキシの状態 + 接続確認を返す。
 *
 * Tor コンテナは docker-compose up で常時起動している。
 * running は SCRAPE_PROXY が設定されているか（= Tor 経由で通信中か）で判定する。
 *
 * レスポンス:
 *   { running: boolean, scrapeProxy: string, torProxy: string, connection: {...} }
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const scrapeProxy = process.env.SCRAPE_PROXY || "";
  const torProxy = process.env.TOR_PROXY || "";
  // Tor コンテナは常時起動。running は SCRAPE_PROXY が設定されているかで判定。
  const running = scrapeProxy === SOCKS_PROXY;

  // 実際の Tor 接続確認: scraper の /tor-check を呼ぶ
  // 直接接続IP と Tor 経由IP を比較し、実際に Tor が機能しているか検証
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
      connection.error = err instanceof Error ? err.message : "接続確認に失敗";
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
 * POST /api/tor — Tor プロキシの有効/無効を切り替える。
 *
 * Tor コンテナ自体は docker-compose up で常時起動している。
 * この API は SCRAPE_PROXY / TOR_PROXY の .env 書き換え + scraper 再起動のみ行う。
 *
 * action=start:  SCRAPE_PROXY / TOR_PROXY を socks5://tor:9050 に設定
 * action=stop:   SCRAPE_PROXY / TOR_PROXY を空に設定
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

  // .env の SCRAPE_PROXY と TOR_PROXY を更新
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

  // scraper コンテナを再起動して SCRAPE_PROXY の変更を反映
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
