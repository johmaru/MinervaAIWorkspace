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

  // ユーザー作成。最初のユーザーの場合、既存のオーナー無しデータを全て移行。
  const userCount = await db.$count(users);
  const [user] = await db
    .insert(users)
    .values({ nickname, email, passwordHash })
    .returning({ id: users.id, nickname: users.nickname, email: users.email });

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
 * logout — セッション破棄して /login にリダイレクト。
 */
export async function logout(): Promise<void> {
  await signOut();
  redirect("/login");
}
