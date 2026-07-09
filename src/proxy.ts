import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";
import { neutralizeAuthUrlForDualAccess } from "@/lib/auth-env";

// Strip sticky AUTH_URL so Auth.js derives origin from request headers
// (dual local + Cloudflare access). Must run before NextAuth().
neutralizeAuthUrlForDualAccess();

export const { auth } = NextAuth(authConfig);

/**
 * Next.js 16 Proxy (formerly middleware).
 * /api/* is excluded (each route authenticates independently). Only page routes are gated by authorized.
 * Unauthenticated page access → redirect to /login.
 */
export default auth;

export const config = {
  // Exclude /api/*, _next/static, _next/image, favicon.ico
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
