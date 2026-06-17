"use client";

import { Sidebar } from "@/components/Sidebar";

export function ChatShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <Sidebar />
      <main className="flex h-full min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
