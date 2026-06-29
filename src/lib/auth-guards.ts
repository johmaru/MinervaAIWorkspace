import { auth } from "@/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

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
 *
 * DB 再作成等で JWT の userId が users テーブルに存在しない場合、
 * セッションを無効化し null を返す（各ルートが 401 → クライアントは /login へ遷移）。
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  const userId = session.user.id;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  return session.user as SessionUser;
}
