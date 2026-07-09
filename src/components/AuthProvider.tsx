"use client";

import { createContext, useContext } from "react";

type SessionUser = {
  id: string;
  name?: string | null;
  email?: string | null;
};

const AuthContext = createContext<SessionUser | null>(null);

/**
 * Provides the authenticated user to client components.
 * The user is obtained via auth() in the Server Component (page.tsx) and passed down.
 * Nickname etc. can be referenced via useUser() (e.g. in Sidebar).
 */
export function AuthProvider({
  user,
  children,
}: {
  user: SessionUser | null;
  children: React.ReactNode;
}) {
  return <AuthContext.Provider value={user}>{children}</AuthContext.Provider>;
}

export function useUser() {
  return useContext(AuthContext);
}
