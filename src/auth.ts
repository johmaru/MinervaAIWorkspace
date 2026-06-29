import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { authConfig } from "@/auth.config";
import { db } from "@/db";
import { users, accounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyPassword } from "@/lib/password";

/**
 * Auth.js v5 本体設定。
 * - DrizzleAdapter: users/accounts/sessions/verification_tokens を使用（カスタムスキーマで既存テーブルを指定）
 * - session.strategy: "jwt"（Credentials では必須）
 * - Credentials provider: email + password で認証
 * - Google provider: GOOGLE_CLIENT_ID/SECRET 設定時のみ有効化
 * - signIn callback: Google 初回ログイン時に users/accounts 行を手動作成（JWT 戦略では
 *   handleLoginOrRegister の getUserByAccount が既存ユーザーを見つけて createUser/linkAccount
 *   をスキップするため、事前作成が必要）
 * - jwt callback: userId を JWT に付与
 * - session callback: session.user.id に userId を表面化
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
        if (!user || !user.passwordHash) return null; // OAuth 専用ユーザーは Credentials 拒否
        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) return null;
        return { id: user.id, name: user.nickname, email: user.email };
      },
    }),
    // GOOGLE_CLIENT_ID/SECRET が未設定の環境では Credentials のみで動作
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
    // Google ログイン前に呼ばれる。JWT 戦略では handleLoginOrRegister の
    // getUserByAccount が accounts 行を見つけて createUser/linkAccount をスキップするため、
    // ここで users/accounts を事前作成（または既存ユーザーへリンク）する。
    // Credentials ログイン時も呼ばれるが、provider !== "google" で早期 return するため影響しない。
    signIn: async ({ user, account }) => {
      if (account?.provider !== "google" || !user?.email) return true;
      const email = user.email.toLowerCase().trim();
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email));
      if (existing) {
        // 既存ユーザーに Google アカウントをリンク（accounts 行が未存在なら作成）
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
      // 新規 Google ユーザー作成（passwordHash は null）
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
      return true;
    },
    jwt: async ({ token, user }) => {
      if (user) token.userId = user.id; // userId を JWT に付与
      return token;
    },
    session: async ({ session, token }) => {
      if (token?.userId) {
        // DB 再作成等で JWT の userId が users テーブルに存在しない場合、
        // session.user.id を設定せず authorized が false を返すようにする。
        // これにより /login へのリダイレクトが発生し、再ログインを促す。
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
