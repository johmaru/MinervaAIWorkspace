import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { authConfig } from "@/auth.config";
import { db } from "@/db";
import { users, accounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyPassword } from "@/lib/password";
import { canCreateNewAccount } from "@/lib/registration-gate";
import { logger } from "@/lib/logger";

/**
 * Auth.js v5 main configuration.
 * - DrizzleAdapter: uses users/accounts/sessions/verification_tokens (custom schema specifies existing tables)
 * - session.strategy: "jwt" (required for Credentials)
 * - Credentials provider: authenticates with email + password
 * - Google provider: enabled only when GOOGLE_CLIENT_ID/SECRET is set
 * - signIn callback: manually creates users/accounts rows on first Google login (with JWT strategy,
 *   handleLoginOrRegister's getUserByAccount finds the existing user and skips createUser/linkAccount,
 *   so pre-creation is needed)
 * - jwt callback: attaches userId to the JWT
 * - session callback: exposes userId via session.user.id
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    // accounts のプロパティ名（camelCase）がアダプター期待型（snake_case）と異なるため
    // キャストして渡す。JWT 戦略では signIn callback で手動作成するため
    // アダプターの account 系メソッド（linkAccount 等）は実行されない。
    accountsTable: accounts as never,
  }),
  session: { strategy: "jwt", maxAge: 6 * 60 * 60 }, // 6h — short-lived for tunnel-exposed instances
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (credentials) => {
        const email = String(credentials.email ?? "").toLowerCase().trim();
        const password = String(credentials.password ?? "");
        if (!email || !password) return null;
        const [user] = await db
          .select({
            id: users.id,
            nickname: users.nickname,
            email: users.email,
            passwordHash: users.passwordHash,
          })
          .from(users)
          .where(eq(users.email, email));
        if (!user || !user.passwordHash) {
          logger.warn("auth", "login-failure", { provider: "credentials" });
          return null; // Reject Credentials for OAuth-only users
        }
        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) {
          logger.warn("auth", "login-failure", { provider: "credentials" });
          return null;
        }
        logger.info("auth", "login-success", { provider: "credentials" });
        return { id: user.id, name: user.nickname, email: user.email };
      },
    }),
    // In environments without GOOGLE_CLIENT_ID/SECRET, runs with Credentials only
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [
          Google({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),
  ],
  callbacks: {
    ...authConfig.callbacks,
    // Called before Google login. With JWT strategy, handleLoginOrRegister's
    // getUserByAccount finds the accounts row and skips createUser/linkAccount,
    // so users/accounts are pre-created here (or linked to an existing user).
    // Also called on Credentials login, but returns early when provider !== "google", so no effect.
    signIn: async ({ user, account }) => {
      if (account?.provider !== "google" || !user?.email) return true;
      const email = user.email.toLowerCase().trim();
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email));
      if (existing) {
        // Link Google account to existing user (create accounts row if it doesn't exist)
        const [acct] = await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(
            and(
              eq(accounts.provider, "google"),
              eq(accounts.providerAccountId, account.providerAccountId),
            ),
          )
          .limit(1);
        if (!acct) {
          await db.insert(accounts).values({
            userId: existing.id,
            type: "oauth",
            provider: "google",
            providerAccountId: account.providerAccountId,
            accessToken: account.access_token ?? null,
            refreshToken: account.refresh_token ?? null,
            expiresAt: account.expires_at
              ? new Date(account.expires_at * 1000)
              : null,
            tokenType: account.token_type ?? null,
            scope: account.scope ?? null,
            idToken: account.id_token ?? null,
          });
        }
        return true;
      }
      // Registration gate: lock + IP whitelist (extracted for testability)
      if (!(await canCreateNewAccount(false))) return false;
      // Create new Google user (passwordHash is null)
      const nickname = user.name ?? email.split("@")[0];
      const [newUser] = await db
        .insert(users)
        .values({
          nickname,
          email,
          name: user.name ?? null,
          image: user.image ?? null,
          emailVerified: new Date(),
        })
        .returning({ id: users.id });
      await db.insert(accounts).values({
        userId: newUser.id,
        type: "oauth",
        provider: "google",
        providerAccountId: account.providerAccountId,
        accessToken: account.access_token ?? null,
        refreshToken: account.refresh_token ?? null,
        expiresAt: account.expires_at
          ? new Date(account.expires_at * 1000)
          : null,
        tokenType: account.token_type ?? null,
        scope: account.scope ?? null,
        idToken: account.id_token ?? null,
      });
      logger.info("auth", "login-success", { provider: account?.provider });
      return true;
    },
    jwt: async ({ token, user }) => {
      if (user) token.userId = user.id; // Attach userId to the JWT
      return token;
    },
    session: async ({ session, token }) => {
      if (token?.userId) {
        // If the JWT's userId no longer exists in the users table (e.g. after DB recreation),
        // do not set session.user.id so that authorized returns false.
        // This triggers a redirect to /login, prompting re-authentication.
        const [row] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, token.userId as string))
          .limit(1);
        if (row) {
          session.user = { ...session.user, id: token.userId as string };
        }
      }
      return session;
    },
  },
});
