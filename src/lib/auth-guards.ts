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
 * Returns the authenticated user, or null if unauthenticated.
 * Route handlers check for null and return 401:
 *
 *   const user = await getSessionUser();
 *   if (!user) return new Response("Unauthorized", { status: 401 });
 *
 * Returns null (does not throw) so each handler controls its response shape.
 * auth() reads the JWT from request cookies.
 *
 * If the JWT's userId no longer exists in the users table (e.g. DB recreated),
 * the session is invalidated and null is returned (each route returns 401 → client redirects to /login).
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
