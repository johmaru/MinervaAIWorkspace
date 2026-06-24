import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { authConfig } from "@/auth.config";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyPassword } from "@/lib/password";

/**
 * Auth.js v5 本体設定。
 * - DrizzleAdapter: users/accounts/sessions/verification_tokens を使用
 * - session.strategy: "jwt"（Credentials では必須）
 * - Credentials provider: email + password で認証
 * - jwt callback: userId を JWT に付与
 * - session callback: session.user.id に userId を表面化
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: DrizzleAdapter(db),
  session: { strategy: "jwt" }, // Credentials では必須
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
        if (!user) return null;
        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) return null;
        return { id: user.id, name: user.nickname, email: user.email };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    jwt: async ({ token, user }) => {
      if (user) token.userId = user.id; // userId を JWT に付与
      return token;
    },
    session: async ({ session, token }) => {
      if (token?.userId)
        session.user = { ...session.user, id: token.userId as string };
      return session;
    },
  },
});
