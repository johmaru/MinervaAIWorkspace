import { db } from "@/db";
import { users } from "@/db/schema";
import { LoginForm } from "@/components/LoginForm";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

/**
 * /login — ログイン/アカウント作成ページ。
 * ユーザーが0件 → register モード（最初の管理者アカウント作成）。
 * ユーザーが存在 → login モード。
 */
export default async function LoginPage() {
  const session = await auth();
  if (session?.user?.id) redirect("/");

  const userCount = await db.$count(users);
  const firstRun = userCount === 0;
  const googleEnabled = !!(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );

  return (
    <LoginForm
      initialMode={firstRun ? "register" : "login"}
      firstRun={firstRun}
      googleEnabled={googleEnabled}
    />
  );
}
