import { auth } from "@/auth";

export type SessionUser = {
  id: string;
  name?: string | null;
  email?: string | null;
};

/**
 * 認証済みユーザーを返す。未認証なら null。
 * ルートハンドラは null をチェックし 401 を返す:
 *
 *   const user = await getSessionUser();
 *   if (!user) return new Response("Unauthorized", { status: 401 });
 *
 * null を返す（throw しない）ことで、各ハンドラがレスポンス形状を制御できる。
 * auth() はリクエスト Cookie から JWT を読み取る。
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return session.user as SessionUser;
}
