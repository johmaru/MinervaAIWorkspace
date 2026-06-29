import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "./schema";

/**
 * アプリ全体で共有する Drizzle DB インスタンスの型。
 * better-sqlite3 は sync ドライバ。
 */
export type Db = BetterSQLite3Database<typeof schema>;

const globalForDb = globalThis as unknown as {
  sqlite?: Database.Database;
  db?: Db;
};

const dbPath = process.env.DATABASE_URL || join(process.cwd(), "data", "umanschat.db");

// データディレクトリを確保（初回起動時）
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite =
  globalForDb.sqlite ??
  (() => {
    const instance = new Database(dbPath);
    // WAL モード: 書き込み中の並行読み取りを許可
    instance.pragma("journal_mode = WAL");
    // 外部キー制約を有効化（SQLite のデフォルトは OFF）
    instance.pragma("foreign_keys = ON");
    return instance;
  })();

if (process.env.NODE_ENV !== "production") {
  globalForDb.sqlite = sqlite;
}

export const db: Db = globalForDb.db ?? drizzle(sqlite, { schema });
if (process.env.NODE_ENV !== "production") {
  globalForDb.db = db;
}
