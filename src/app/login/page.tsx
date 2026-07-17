import { db } from "@/db";
import { users } from "@/db/schema";
import { LoginForm } from "@/components/LoginForm";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

/**
 * /login — Login / account creation page.
 * 0 users → register mode (create first admin account).
 * Users exist → login mode.
 *
 * If a JWT session exists but its userId is no longer in the DB (e.g. after
 * migration recreated the DB), we don't redirect to / — instead we pass
 * sessionInvalid=true so LoginForm can clear the HttpOnly cookies and show
 * the reset notice.
 */
export default async function LoginPage() {
  const session = await auth();
  let sessionInvalid = false;
  if (session?.user?.id) {
    // Verify the session's userId still exists in the DB.
    // After migration/recreation, old JWTs reference non-existent users.
    const [userRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);
    if (userRow) {
      redirect("/");
    }
    sessionInvalid = true;
  }

  const userCount = await db.$count(users);
  const firstRun = userCount === 0;
  const googleEnabled = !!(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );
  const githubEnabled = !!(
    process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
  );
  const microsoftEnabled = !!(
    process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET
  );

  return (
    <LoginForm
      initialMode={firstRun ? "register" : "login"}
      firstRun={firstRun}
      googleEnabled={googleEnabled}
      githubEnabled={githubEnabled}
      microsoftEnabled={microsoftEnabled}
      sessionInvalid={sessionInvalid}
    />
  );
}
