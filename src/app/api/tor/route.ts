import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getRequestLocale, t } from "@/lib/i18n";

const execAsync = promisify(exec);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COMPOSE_DIR = process.cwd();
const SOCKS_PROXY = "socks5://tor:9050";

/**
 * GET /api/tor — Tor コンテナの状態 + 現在のプロキシ設定を返す。
 *
 * レスポンス:
 *   { running: boolean, scraPeProxy: string, torProxy: string }
 */
export async function GET() {
  let running = false;
  try {
    const { stdout } = await execAsync(
      `docker ps --filter name=umanschat-tor --filter status=running --format "{{.Names}}"`,
      { cwd: COMPOSE_DIR },
    );
    running = stdout.trim().includes("umanschat-tor");
  } catch {
    // docker コマンドが無い or エラー時は停止扱い
  }

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
    scrapeProxy: process.env.SCRAPE_PROXY || "",
    torProxy: process.env.TOR_PROXY || "",
    socksProxy: SOCKS_PROXY,
    connection,
  });
}

type TorBody = {
  action: "start" | "stop" | "restart-scraper";
};

/**
 * POST /api/tor — Tor コンテナの起動/停止 + SCRAPE_PROXY の切り替え。
 *
 * action=start:
 *   1. docker compose up -d tor で Tor コンテナ起動
 *   2. .env の SCRAPE_PROXY を socks5://tor:9050 に設定
 *
 * action=stop:
 *   1. docker compose stop tor で Tor コンテナ停止
 *   2. .env の SCRAPE_PROXY を空に設定
 */
export async function POST(req: Request) {
  const locale = getRequestLocale(req);
  let body: TorBody;
  try {
    body = (await req.json()) as TorBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (body.action !== "start" && body.action !== "stop" && body.action !== "restart-scraper") {
    return new Response("action must be start, stop, or restart-scraper", { status: 400 });
  }

  // scraper コンテナの再起動のみ（SCRAPE_PROXY の変更を反映）
  if (body.action === "restart-scraper") {
    try {
      await execAsync("docker compose restart scraper", {
        cwd: COMPOSE_DIR,
        timeout: 60_000,
      });
      return Response.json({ success: true, message: t(locale, "settings.apiTorRestartScraperOk") });
    } catch (err) {
      return Response.json(
        { error: t(locale, "settings.apiTorRestartScraperFail", { error: err instanceof Error ? err.message : String(err) }) },
        { status: 500 },
      );
    }
  }

  const wantProxy = body.action === "start" ? SOCKS_PROXY : "";

  // Tor コンテナの起動/停止
  try {
    const cmd = body.action === "start" ? "up -d --force-recreate tor" : "stop tor";
    await execAsync(`docker compose ${cmd}`, {
      cwd: COMPOSE_DIR,
      timeout: 60_000,
    });
  } catch (err) {
    return Response.json(
      { error: t(locale, "settings.apiTorContainerFail", { action: body.action === "start" ? t(locale, "settings.torStart") : t(locale, "settings.torStop"), error: err instanceof Error ? err.message : String(err) }) },
      { status: 500 },
    );
  }
  // .env の SCRAPE_PROXY と TOR_PROXY を更新
  try {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const envPath = resolve(process.cwd(), ".env");
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

    for (const [key, value] of Object.entries(updates)) {
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
