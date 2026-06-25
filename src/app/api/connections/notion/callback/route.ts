import { db } from "@/db";
import { connections } from "@/db/schema";
import { getSessionUser } from "@/lib/auth-guards";
import { exchangeNotionCode } from "@/lib/connections/notion";
import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/connections/notion/callback — Notion OAuth コールバック。
 *
 * Notion が ?code=...&state=... 付きでリダイレクトする。
 * state は CSRF 防止用にユーザー ID をエンコードしている。
 * コードをトークンに交換し、connections テーブルへ保存してルートへリダイレクト。
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return redirect("/login");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // ユーザーが Notion 側で認可を拒否した場合
  if (error) return redirect("/?connection_error=notion_denied");

  // CSRF チェック: state はログインユーザー ID と一致する必要がある
  if (!code || !state || state !== user.id) {
    return new Response("Invalid OAuth state", { status: 400 });
  }

  const redirectUri = `${process.env.AUTH_URL ?? "http://localhost:3001"}/api/connections/notion/callback`;

  try {
    const tokenResponse = await exchangeNotionCode(code, redirectUri);
    await db.insert(connections).values({
      userId: user.id,
      provider: "notion",
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      workspaceName: tokenResponse.workspace_name,
      workspaceIcon: tokenResponse.workspace_icon,
      botId: tokenResponse.bot_id,
      ownerName: tokenResponse.owner?.user?.name ?? null,
      ownerEmail: tokenResponse.owner?.user?.email ?? null,
    });
    return redirect("/?connection_success=notion");
  } catch (err) {
    console.error("[connections] Notion OAuth callback failed:", err);
    return redirect("/?connection_error=notion_failed");
  }
}
