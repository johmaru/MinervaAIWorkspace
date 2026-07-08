"use server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { db } from "@/db";
import { users, threads, folders } from "@/db/schema";
import { eq, isNull, count as sqlCount } from "drizzle-orm";
import { hashPassword } from "@/lib/password";
import { signIn, signOut } from "@/auth";

type FormState = { error?: string } | undefined;

/**
 * register — Create an account.
 * If this is the first user, migrate all ownerless threads/folders.
 * After creation, automatically log in and redirect to /.
 */
export async function register(state: FormState, formData: FormData): Promise<FormState> {
  const nickname = String(formData.get("nickname") ?? "").trim();
  const email = String(formData.get("email") ?? "").toLowerCase().trim();
  const password = String(formData.get("password") ?? "");

  if (nickname.length < 1) return { error: "auth.nicknameRequired" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "auth.emailInvalid" };
  if (password.length < 8) return { error: "auth.passwordTooShort" };

  // Check for existing user
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) return { error: "auth.emailTaken" };

  const passwordHash = await hashPassword(password);

  // Create user + determine if first user within a transaction,
  // preventing a race condition on concurrent registration
  // (both observers see userCount=0 and double-migrate ownerless data).
  // better-sqlite3 is a sync driver: transaction callback must be sync.
  const [user, userCount] = db.transaction((tx) => {
    const count = tx.select({ value: sqlCount() }).from(users).get()?.value ?? 0;
    const inserted = tx
      .insert(users)
      .values({ nickname, email, passwordHash })
      .returning({ id: users.id, nickname: users.nickname, email: users.email })
      .all()[0];
    return [inserted, count] as const;
  });

  if (!user) return { error: "auth.createFailed" };

  if (userCount === 0) {
    // First user: migrate all ownerless threads + folders
    await db.update(threads).set({ userId: user.id }).where(isNull(threads.userId));
    await db.update(folders).set({ userId: user.id }).where(isNull(folders.userId));
  }

  // Auto-login
  await signIn("credentials", { email, password, redirect: false });
  redirect("/");
}

/**
 * login — Log in with credentials.
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
 * authenticate — Unified server action for login/registration.
 * Passing a single stable function reference to useActionState
 * avoids the issue of the action switching on mode change.
 * Determines login/register via the formData mode field.
 */
export async function authenticate(state: FormState, formData: FormData): Promise<FormState> {
  const mode = String(formData.get("mode") ?? "login");
  if (mode === "register") return register(state, formData);
  return login(state, formData);
}

/**
 * logout — Destroy session and redirect to /login.
 */
export async function logout(): Promise<void> {
  await signOut();
  redirect("/login");
}

/**
 * signInWithGoogle — Server action to start Google OAuth login.
 * Calling signIn("google") directly from a Client Component would
 * pull auth.ts → db → pg into the browser bundle, so we call via a server action.
 */
export async function signInWithGoogle(): Promise<void> {
  await signIn("google", { callbackUrl: "/" });
}

/**
 * clearSessionCookies — サーバー側でAuth.js系のHttpOnly Cookieを全て削除する。
 * マイグレーション後に古いJWTが残り、document.cookie経由ではHttpOnlyのため削除できない問題の解決。
 * /loginページのLoginFormから呼ばれる。
 */
export async function clearSessionCookies(): Promise<void> {
  const cookieStore = await cookies();
  // authjs.* (HTTP) と __Secure-authjs.* (HTTPS) 両方をカバー
  const cookieNames = [
    "authjs.session-token",
    "authjs.csrf-token",
    "authjs.callback-url",
    "__Secure-authjs.session-token",
    "__Secure-authjs.csrf-token",
    "__Secure-authjs.callback-url",
  ];
  for (const name of cookieNames) {
    if (cookieStore.has(name)) {
      cookieStore.delete(name);
    }
  }
}
