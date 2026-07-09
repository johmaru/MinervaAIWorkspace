import { TranslateClient } from "@/components/TranslateClient";

/**
 * /translate — AI translation page.
 * Thin server component. Auth is enforced by proxy.ts middleware
 * (matcher excludes only /api, _next/*, favicon.ico), so unauthenticated
 * access redirects to /login automatically — same pattern as src/app/page.tsx.
 */
export default function TranslatePage() {
  return <TranslateClient />;
}
