"use client";

import { clearSessionCookies } from "@/app/actions/auth";

/**
 * Client-side fetch wrapper.
 * On 401 (unauthenticated / invalid session), automatically redirects to /login.
 * When the JWT's userId no longer exists in the users table (e.g. DB recreated),
 * the server returns 401; this catches it and navigates to the login screen.
 */
export async function clientFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) {
    // 401 = invalid session (JWT userId not found, e.g. after DB recreation).
    // Delete auth cookies via Server Action (HttpOnly cookies can't be deleted
    // from document.cookie). Then full-reload to /login where the server-side
    // page also detects invalid sessions and shows the reset notice.
    try {
      await clearSessionCookies();
    } catch {
      // Ignore — /login page will re-detect and re-delete server-side.
    }
    window.location.href = "/login";
  }
  return res;
}
