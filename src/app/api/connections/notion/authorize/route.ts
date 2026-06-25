import { getSessionUser } from "@/lib/auth-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/connections/notion/authorize — Notion OAuth 認可 URL へリダイレクト。
 * 「Notion に接続」ボタンのリンク先。
 * state にユーザー ID をセットし CSRF 防止。
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const clientId = process.env.NOTION_CLIENT_ID;
  if (!clientId) return new Response("NOTION_CLIENT_ID is not set", { status: 500 });

  const redirectUri = `${process.env.AUTH_URL ?? "http://localhost:3001"}/api/connections/notion/callback`;
  const state = user.id;
  const authUrl = `https://api.notion.com/v1/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&owner=user&state=${state}`;
  return Response.redirect(authUrl);
}
