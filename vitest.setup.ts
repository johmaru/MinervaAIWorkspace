import "@testing-library/jest-dom/vitest";
// jsdom は HTMLElement.prototype.scrollTo を実装していない。
// ChatWindow などのスクロール自動追従がテストで TypeError を出すため polyfill。
if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function () {};
}

import { tmpdir } from "node:os";
import { readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

// .env の Docker パス (/app/data/) をテスト用の一時ファイルで上書き。
// :memory: は openDatabase の fileMustExist プローブで throw →
// recoverDatabase 経由で corruption 警告が出るため使わない。
// VITEST_WORKER_ID で各 worker スレッドに固有のファイルを割り当て、
// 並列実行時の migrate 競合 ("table already exists") を回避する。
// 前回実行の残留ファイルがあれば削除してから新規作成する。
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("/app/data/")) {
  const workerId = process.env.VITEST_WORKER_ID ?? "0";
  process.env.DATABASE_URL = join(tmpdir(), `umanschat-test-${process.pid}-${workerId}.db`);
  try { unlinkSync(process.env.DATABASE_URL); } catch { /* 初回は存在しない */ }
}

// Vitest は Next.js のように .env を自動読み込みしない。
// 実 API (api.code.umans.ai) を叩く Route Handler テストが
// LLM_BASE_URL / LLM_API_KEY / LLM_MODEL を必要とするため、
// プロジェクトルートの .env を最小のパーサで process.env に注入する。
// 既に env に設定されている値は上書きしない（CI 側で差し替え可能にするため）。
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
  // .env が無い場合はスキップ（CI で env 直書きの場合など）
}

// ホストからテスト実行時、Docker 内部サービス名をホスト到達可能なポートへ上書き。
// Docker 内 (本番) は docker-compose.yml の environment で上書きされるため影響なし。
if (process.env.EMBEDDER_URL?.includes("embedder:")) {
  process.env.EMBEDDER_URL = "http://localhost:8001";
}
if (process.env.SEARXNG_URL?.includes("searxng:")) {
  process.env.SEARXNG_URL = "http://localhost:8081";
}

// 静的 import は hoist され DATABASE_URL 設定前に @/db が評価されるため、
// 動的 import で DATABASE_URL 設定後に読み込む。
// db は globalThis にキャッシュされるため全テストファイルが同じ migrated DB を共有。
// マイグレーション・テストユーザー作成は1プロセス内で1回のみ（globalThis guard）。
const globalForTestSetup = globalThis as unknown as { __umanschatTestDbReady?: boolean };
if (!globalForTestSetup.__umanschatTestDbReady) {
  const { db } = await import("@/db");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });

  // auth-guards をモックするテスト群（getSessionUser → { id: "test-user-id" }）の
  // ため、FK 制約を満たすテストユーザーを事前作成。全テストで共有するため
  // afterAll では削除しない（一時 DB は使い捨て）。
  const { users } = await import("@/db/schema");
  await db.insert(users).values({ id: "test-user-id", nickname: "tester", email: "t@example.com" }).onConflictDoNothing();
  globalForTestSetup.__umanschatTestDbReady = true;
}
