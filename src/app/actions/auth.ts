"use server";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users, threads, folders } from "@/db/schema";
import { eq, isNull } from "drizzle-orm";
import { hashPassword } from "@/lib/password";
import { signIn, signOut } from "@/auth";

type FormState = { error?: string } | undefined;

/**
 * register — アカウント作成。
 * 最初のユーザーの場合、既存のオーナー無しスレッド/フォルダを全て移行する。
 * 作成後は自動ログインして / にリダイレクト。
 */
export async function register(state: FormState, formData: FormData): Promise<FormState> {
  const nickname = String(formData.get("nickname") ?? "").trim();
  const email = String(formData.get("email") ?? "").toLowerCase().trim();
  const password = String(formData.get("password") ?? "");

  if (nickname.length < 1) return { error: "auth.nicknameRequired" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "auth.emailInvalid" };
  if (password.length < 8) return { error: "auth.passwordTooShort" };

  // 既存ユーザーチェック
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) return { error: "auth.emailTaken" };

  const passwordHash = await hashPassword(password);

  // ユーザー作成 + 初回ユーザー判定をトランザクション内で行い、
  // 並行登録時の競合状態（両者とも userCount=0 を観測してオーナー無しデータを
  // 二重移行する問題）を防止する。
  const [user, userCount] = await db.transaction(async (tx) => {
    const count = await tx.$count(users);
    const [inserted] = await tx
      .insert(users)
      .values({ nickname, email, passwordHash })
      .returning({ id: users.id, nickname: users.nickname, email: users.email });
    return [inserted, count] as const;
  });

  if (!user) return { error: "auth.createFailed" };

  if (userCount === 0) {
    // 最初のユーザー: オーナー無しスレッド + フォルダを全て移行
    await db.update(threads).set({ userId: user.id }).where(isNull(threads.userId));
    await db.update(folders).set({ userId: user.id }).where(isNull(folders.userId));
  }

  // 自動ログイン
  await signIn("credentials", { email, password, redirect: false });
  redirect("/");
}

/**
 * login — Credentials でログイン。
 */
export async function login(state: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "").toLowerCase().trim();
  const password = String(formData.get("password") ?? "");
  try {
    await signIn("credentials", { email, password, redirect: false });
  } catch {
    return { error: "auth.invalidCredentials" };
  }
  redirect("/");
}

/**
 * authenticate — ログイン/登録を統合したサーバーアクション。
 * useActionState に単一の安定した関数参照を渡すため、
 * モード切替で action が切り替わる問題を回避する。
 * formData の mode フィールドで login/register を判定。
 */
export async function authenticate(state: FormState, formData: FormData): Promise<FormState> {
  const mode = String(formData.get("mode") ?? "login");
  if (mode === "register") return register(state, formData);
  return login(state, formData);
}

/**
 * logout — セッション破棄して /login にリダイレクト。
 */
export async function logout(): Promise<void> {
  await signOut();
  redirect("/login");
}

/**
 * signInWithGoogle — Google OAuth ログインを開始するサーバーアクション。
 * Client Component から直接 signIn("google") を呼ぶと auth.ts → db → pg が
 * ブラウザバンドルに巻き込まれるため、サーバーアクション経由で呼ぶ。
 */
export async function signInWithGoogle(): Promise<void> {
  await signIn("google", { callbackUrl: "/" });
}
