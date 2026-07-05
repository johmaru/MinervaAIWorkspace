import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { mkdirSync, renameSync, unlinkSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, basename, join } from "node:path";
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

  // 読み取り専用プローブで整合性を確認してから読み書き用に開き直す。
  // better-sqlite3 は読み書きモードで破損 DB を開いた際、コンストラクタが
  // 例外を投げてもネイティブのファイルハンドルを解放しない（Windows で顕著）。
  // ハンドルが残っていると renameSync が EBUSY で失敗し recoverDatabase が
  // バックアップを退避できなくなる。readonly プローブはヘッダー検証を行わず
  // 開けるため、close() で確実にハンドルを解放できる。
  let probe: Database.Database | null = null;
  try {
    probe = new Database(dbPath, { readonly: true, fileMustExist: true });
    const status = probe.pragma("integrity_check", { simple: true });
    probe.close();
    probe = null;
    if (status !== "ok") {
      // 整合性チェック失敗 → 修復へ（ハンドルは解放済み、rename 可能）。
      return recoverDatabase(dbPath);
    }
  } catch {
    // プローブの open または integrity_check が失敗（例: SQLITE_NOTADB）。
    // ハンドルを確実に解放してから修復へ。
    if (probe) {
      try { probe.close(); } catch { /* noop */ }
      probe = null;
    }
    return recoverDatabase(dbPath);
  }

  // healthy な DB を読み書きモードで開き直す。
  const instance = new Database(dbPath);
  applyPragmas(instance);
  return instance;
}

const SQLITE_MAGIC = Buffer.from("SQLite format 3\x00");

// path の先頭 16 バイトが SQLite magic なら真。読み込み失敗時は偽。
function isSqliteFile(path: string): boolean {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return false; }
  const buf = Buffer.alloc(16);
  const n = readSync(fd, buf, 0, 16, 0);
  closeSync(fd);
  return n >= 16 && buf.subarray(0, 16).equals(SQLITE_MAGIC);
}

// デプロイ済みバグが dbPath に SQL テキストを書き込み、実 DB を
// *.corrupt-* に退避していた場合、その実 DB から回復を試みる。
function findRealBackup(dbPath: string, backupPath: string): string | null {
  const dir = dirname(dbPath);
  let files: string[];
  try { files = readdirSync(dir); } catch { return null; }
  const base = basename(dbPath);
  const candidates = files
    .filter((f) => f.startsWith(`${base}.corrupt-`))
    .map((f) => join(dir, f))
    .filter((f) => f !== backupPath);
  if (candidates.length === 0) return null;
  // 一番新しいものを選び、SQLite ヘッダーを持つか確認。
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of candidates) {
    if (isSqliteFile(f)) return f;
  }
  return null;
}

function recoverDatabase(dbPath: string): Database.Database {
  const backupPath = `${dbPath}.corrupt-${Date.now()}`;
  try {
    renameSync(dbPath, backupPath);
  } catch {
    // ファイルが存在しない等の場合は backupPath 未生成で続行。
  }
  for (const ext of ["-wal", "-shm", "-journal"]) {
    try { unlinkSync(dbPath + ext); } catch { /* 存在しない場合は無視 */ }
  }
  // .recover は SQL テキストを stdout に出力する。シェルの `>` で dbPath
  // に書き込むと SQL テキストファイルになり SQLITE_NOTADB でクラッシュする。
  // 正しくは .recover の出力を別の sqlite3 プロセスにパイプしてバイナリ DB
  // を構築する: `sqlite3 <backup> .recover | sqlite3 <newdb>`。
  // backupPath が SQLite でない（=デプロイ済みバグの SQL テキスト）場合、
  // 直前の実 DB バックアップから回復を試みる。
  let recoverSource = backupPath;
  if (!isSqliteFile(backupPath)) {
    recoverSource = findRealBackup(dbPath, backupPath) ?? backupPath;
  }
  try {
    // 新規空 DB を作成（存在しない場合）。.recover の SQL をパイプで流し込む。
    execSync(`sqlite3 "${recoverSource}" ".recover" | sqlite3 "${dbPath}"`, { stdio: "ignore" });
  } catch {
    // sqlite3 CLI 不在または .recover 失敗 → 空の新規ファイル。マイグレーションがスキーマを再構築。
    new Database(dbPath).close();
  }
  try {
    const healed = new Database(dbPath);
    healed.pragma("journal_mode = DELETE");
    healed.pragma("synchronous = NORMAL");
    healed.pragma("foreign_keys = ON");
    console.warn(`[db] Recovered from corruption. Backup: ${backupPath}`);
    return healed;
  } catch {
    // 回復したファイルが開けない場合は空の新規 DB にフォールバック。
    new Database(dbPath).close();
    const fresh = new Database(dbPath);
    fresh.pragma("journal_mode = DELETE");
    fresh.pragma("synchronous = NORMAL");
    fresh.pragma("foreign_keys = ON");
    console.warn(`[db] Recovery failed; started fresh DB. Backup: ${backupPath}`);
    return fresh;
  }
}

const sqlite = globalForDb.sqlite ?? openDatabase(dbPath);

if (process.env.NODE_ENV !== "production") {
  globalForDb.sqlite = sqlite;
}

export const db: Db = globalForDb.db ?? drizzle(sqlite, { schema });
if (process.env.NODE_ENV !== "production") {
  globalForDb.db = db;
}
