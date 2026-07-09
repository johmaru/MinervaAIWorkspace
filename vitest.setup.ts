import "@testing-library/jest-dom/vitest";
// jsdom does not implement HTMLElement.prototype.scrollTo.
// Auto-scroll-follow in ChatWindow etc. throws TypeError in tests, so polyfill it.
if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function () {};
}

import { tmpdir } from "node:os";
import { readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

// Override the Docker path (/app/data/) from .env with a temp file for testing.
// :memory: causes openDatabase's fileMustExist probe to throw →
// recoverDatabase emits a corruption warning, so it is not used.
// VITEST_WORKER_ID assigns a unique file per worker thread to avoid
// migrate races ("table already exists") during parallel execution.
// Remove any leftover file from a previous run before creating a new one.
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("/app/data/")) {
  const workerId = process.env.VITEST_WORKER_ID ?? "0";
  process.env.DATABASE_URL = join(tmpdir(), `umanschat-test-${process.pid}-${workerId}.db`);
  try { unlinkSync(process.env.DATABASE_URL); } catch { /* does not exist on first run */ }
}

// Vitest does not auto-load .env like Next.js does.
// Route Handler tests that call the real API (api.code.umans.ai)
// require LLM_BASE_URL / LLM_API_KEY / LLM_MODEL, so inject the
// project root .env into process.env with a minimal parser.
// Values already set in env are not overwritten (so CI can override them).
try {
  const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
} catch {
  // Skip if .env is absent (e.g. when env is set directly in CI)
}

// When running tests from the host, override Docker-internal service names with host-reachable ports.
// Inside Docker (production) these are overridden by docker-compose.yml environment, so no effect.
if (process.env.EMBEDDER_URL?.includes("embedder:")) {
  process.env.EMBEDDER_URL = "http://localhost:8001";
}
if (process.env.SEARXNG_URL?.includes("searxng:")) {
  process.env.SEARXNG_URL = "http://localhost:8081";
}

// Static imports are hoisted, so @/db would be evaluated before DATABASE_URL is set.
// Use dynamic import to load it after DATABASE_URL is configured.
// db is cached on globalThis, so all test files share the same migrated DB.
// Migration and test-user creation run only once per process (globalThis guard).
const globalForTestSetup = globalThis as unknown as { __umanschatTestDbReady?: boolean };
if (!globalForTestSetup.__umanschatTestDbReady) {
  const { db } = await import("@/db");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });

  // For tests that mock auth-guards (getSessionUser → { id: "test-user-id" }),
  // pre-create a test user to satisfy FK constraints. Shared across all tests, so
  // it is not deleted in afterAll (the temp DB is disposable).
  const { users } = await import("@/db/schema");
  await db.insert(users).values({ id: "test-user-id", nickname: "tester", email: "t@example.com" }).onConflictDoNothing();
  globalForTestSetup.__umanschatTestDbReady = true;
}
