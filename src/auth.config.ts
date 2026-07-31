import type { NextAuthConfig } from "next-auth";
import { resolvePublicOrigin } from "@/lib/request-origin";

/**
 * Edge-safe Auth.js configuration.
 * proxy.ts imports only this (does not include DB modules).
 * The authorized callback gates only page routes.
 * API routes (/api/*) are excluded by the matcher; each route authenticates via getSessionUser().
 *
 * Dual-access redirect contract:
 * AUTH_URL is neutralized at load time (src/lib/auth-env.ts) so Auth.js
 * does not rewrite request origins. Redirects here follow the incoming
 * request host via resolvePublicOrigin — a public visit redirects to the
 * public /login, a local visit stays local. authorized never returns false
 * (NextAuth would clone reqWithEnvURL's rewritten nextUrl → localhost).
 */
export const authConfig = {
  pages: { signIn: "/login" },
  callbacks: {
    authorized: ({ auth, request }) => {
      const isLoginPage = request.nextUrl.pathname.startsWith("/login");

      // Authenticated user on /login → redirect to /
      if (isLoginPage && auth) {
        const origin = resolvePublicOrigin(
          request.headers,
          process.env.MINERVA_CONFIGURED_AUTH_URL ??
            process.env.UMANS_CONFIGURED_AUTH_URL ??
            process.env.AUTH_URL ??
            "http://localhost:3001",
        );
        return Response.redirect(new URL("/", origin));
      }

      // Unauthenticated users can view /login
      if (isLoginPage) return true;

      // Authenticated users can access all other pages
      if (auth) return true;

      // Unauthenticated + non-login page → redirect to /login with callbackUrl.
      // Never return false: NextAuth would clone reqWithEnvURL's rewritten
      // request.nextUrl (localhost trap). Build the redirect from the resolved
      // origin so it follows the incoming host (public or local).
      const origin = resolvePublicOrigin(
        request.headers,
        process.env.MINERVA_CONFIGURED_AUTH_URL ??
          process.env.UMANS_CONFIGURED_AUTH_URL ??
          process.env.AUTH_URL ??
          "http://localhost:3001",
      );
      const login = new URL("/login", origin);
      const callback = new URL(
        request.nextUrl.pathname + request.nextUrl.search,
        origin,
      );
      login.searchParams.set("callbackUrl", callback.toString());
      return Response.redirect(login);
    },
  },
  providers: [], // Credentials provider is added in auth.ts
} satisfies NextAuthConfig;
