/**
 * /api/tunnel — Cloudflare Tunnel の起動/停止/状態取得。
 *
 * GET: トンネル状態を返す（トークンは平文で返さない）
 * POST: トークンを使ってトンネルを起動。AUTH_URL が未設定の場合は .env に保存を促す
 * DELETE: トンネルを停止
 *
 * 設計:
 *   - トークンは GET レスポンスに含めない（hasToken で設定済みかのみ返す）
 *   - AUTH_URL は process.env を動的更新（再起動不要、NextAuth は reqWithEnvURL で毎回読む）
 *   - Docker / exe 両環境で動作（src/lib/tunnel.ts が環境を判定）
 */
import { getSessionUser } from "@/lib/auth-guards";
import { getTunnelStatus, startTunnel, stopTunnel } from "@/lib/tunnel";
import { resolveEnvPath, updateEnvContent } from "@/lib/envUtils";
import { readFileSync, writeFileSync } from "node:fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tunnel — トンネル状態を返す。
 *
 * レスポンス:
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
 * POST /api/tunnel — トンネルを起動。
 *
 * body:
 *   token: Cloudflare Tunnel トークン（既存と同じ場合は省略可）
 *   authUrl: 公開 URL（例: https://umanschat.example.com）
 *
 * トークンと AUTH_URL を .env + process.env に保存し、cloudflared を起動。
 * AUTH_URL の動的更新により NextAuth コールバック URL が即時反映（再起動不要）。
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

  // トークン: body にあれば新値、なければ既存の process.env を使用
  const token = body.token || process.env.TUNNEL_TOKEN || "";
  if (!token) {
    return Response.json(
      { error: "TUNNEL_TOKEN が設定されていません" },
      { status: 400 },
    );
  }

  // AUTH_URL: 公開ホスト名
  const authUrl = body.authUrl || process.env.AUTH_URL || "";
  if (!authUrl || !authUrl.startsWith("https://")) {
    return Response.json(
      { error: "AUTH_URL は https:// で始まる公開 URL である必要があります" },
      { status: 400 },
    );
  }

  // .env に保存（トークン + AUTH_URL）
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

    // process.env にも反映（NextAuth が次回リクエストで読む）
    process.env.TUNNEL_TOKEN = token;
    process.env.AUTH_URL = authUrl;
  } catch (err) {
    return Response.json(
      {
        error: `.env の保存に失敗: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }

  // cloudflared を起動
  try {
    // force=true: 既に起動中の場合は停止してから再起動（トークン変更を確実に反映）
    await startTunnel(token, { force: true });
  } catch (err) {
    return Response.json(
      {
        error: `トンネル起動に失敗: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }

  const status = await getTunnelStatus();
  return Response.json({ success: true, ...status });
}

/**
 * DELETE /api/tunnel — トンネルを停止。
 */
export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  try {
    await stopTunnel();
  } catch (err) {
    return Response.json(
      {
        error: `トンネル停止に失敗: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }

  const status = await getTunnelStatus();
  return Response.json({ success: true, ...status });
}
