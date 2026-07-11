import { TranslateClient } from "@/components/TranslateClient";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSessionUser } from "@/lib/auth-guards";

export const dynamic = "force-dynamic";

/**
 * /translate — AI translation page.
 * Thin server component. Auth is enforced by proxy.ts middleware
 * (matcher excludes only /api, _next/*, favicon.ico), so unauthenticated
 * access redirects to /login automatically — same pattern as src/app/page.tsx.
 */
export default async function TranslatePage() {
  const user = await getSessionUser();
  let primaryLang: string | null = null;
  if (user) {
    const [row] = await db
      .select({ translatePrimaryLang: users.translatePrimaryLang })
      .from(users)
      .where(eq(users.id, user.id));
    primaryLang = row?.translatePrimaryLang ?? null;
  }
  return (
    <TranslateClient
      defaultMulti={process.env.TRANSLATE_DEFAULT_MULTI === "true"}
      primaryLang={primaryLang}
    />
  );
}
