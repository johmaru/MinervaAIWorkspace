"use client";

import { createContext, useContext } from "react";

type SessionUser = {
  id: string;
  name?: string | null;
  email?: string | null;
};

const AuthContext = createContext<SessionUser | null>(null);

/**
 * クライアントコンポーネントに認証ユーザーを提供。
 * Server Component (page.tsx) で auth() から取得したユーザーを渡す。
 * useUser() でニックネーム等を参照可能（例: Sidebar）。
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
