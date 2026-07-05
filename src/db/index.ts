import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
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
/**
 * SQLite オープン。DELETE ジャーナルモードを使用する。
 *
 * WAL モードはプロセス間で共有される mmap された -shm ファイルを必要とするが、
 * Docker Desktop (Windows) のバインドマウントではファイル共有レイヤが
 * その mmap を正しく処理せず、破損した 3 バイトの -shm を生成して
 * 最終的に SQLITE_CORRUPT を引き起こす。DELETE モードは通常の -journal
 * ロールバックファイルを使い、バインドマウント上で正しく動作する。
 * トレードオフ（読み書きのブロック）はシングルユーザーのチャットアプリでは無関係。
 *
 * 起動時に integrity_check を実行し、破損時は sqlite3 .recover で
 * 自動修復する（healthy な DB では高速な no-op）。
 */
export function openDatabase(dbPath: string): Database.Database {
  const applyPragmas = (db: Database.Database) => {
    db.pragma("journal_mode = DELETE");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
  };

  let instance: Database.Database;
  try {
    instance = new Database(dbPath);
    applyPragmas(instance);
  } catch {
    // open または pragma の失敗（例: SQLITE_NOTADB）も破損として扱い修復へ。
    instance = recoverDatabase(dbPath);
    return instance;
  }

  // 自己修復: 破損 DB を起動時に回復（既存のバインドマウント破損ファイル用）。
  // healthy な DB ではインデックススキャンのみの高速な no-op。
  const status = instance.pragma("integrity_check", { simple: true });
  if (status !== "ok") {
    instance.close();
    return recoverDatabase(dbPath);
  }
  return instance;
}

function recoverDatabase(dbPath: string): Database.Database {
  const backupPath = `${dbPath}.corrupt-${Date.now()}`;
  try {
    renameSync(dbPath, backupPath);
  } catch {
    // ファイルが存在しない等の場合は空の新規 DB にフォールバック。
  }
  for (const ext of ["-wal", "-shm", "-journal"]) {
    try { unlinkSync(dbPath + ext); } catch { /* 存在しない場合は無視 */ }
  }
  try {
    execSync(`sqlite3 "${backupPath}" ".recover" > "${dbPath}"`, { stdio: "ignore" });
  } catch {
    // sqlite3 CLI が不在または recover 失敗 → 空の新規ファイル。マイグレーションがスキーマを再構築。
    new Database(dbPath).close();
  }
  const healed = new Database(dbPath);
  healed.pragma("journal_mode = DELETE");
  healed.pragma("synchronous = NORMAL");
  healed.pragma("foreign_keys = ON");
  console.warn(`[db] Recovered from corruption. Backup: ${backupPath}`);
  return healed;
}

const sqlite = globalForDb.sqlite ?? openDatabase(dbPath);

if (process.env.NODE_ENV !== "production") {
  globalForDb.sqlite = sqlite;
}

export const db: Db = globalForDb.db ?? drizzle(sqlite, { schema });
if (process.env.NODE_ENV !== "production") {
  globalForDb.db = db;
}
