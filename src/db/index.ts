import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync, renameSync, unlinkSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, basename, join } from "node:path";
import * as schema from "./schema";
import { logger } from "../lib/logger";

/**
 * Type of the Drizzle DB instance shared across the app.
 * better-sqlite3 is a sync driver.
 */
export type Db = BetterSQLite3Database<typeof schema>;

const globalForDb = globalThis as unknown as {
  sqlite?: Database.Database;
  db?: Db;
};

const DEFAULT_DB_REL = join("data", "minerva.db");
const LEGACY_DB_REL = join("data", "umanschat.db");

function resolveDefaultDbPath(): string {
  const preferred = join(process.cwd(), DEFAULT_DB_REL);
  const legacy = join(process.cwd(), LEGACY_DB_REL);
  if (!existsSync(preferred) && existsSync(legacy)) {
    mkdirSync(dirname(preferred), { recursive: true });
    cpSync(legacy, preferred, { force: true });
  }
  return preferred;
}

const dbPath = process.env.DATABASE_URL || resolveDefaultDbPath();

// Ensure the data directory exists (on first launch)
mkdirSync(dirname(dbPath), { recursive: true });
/**
 * Opens SQLite. Uses DELETE journal mode.
 *
 * WAL mode requires an mmap'd -shm file shared across processes, but
 * Docker Desktop (Windows) bind mounts do not handle the file-sharing layer's
 * mmap correctly, producing a corrupted 3-byte -shm and ultimately
 * SQLITE_CORRUPT. DELETE mode uses a regular -journal rollback file
 * and works correctly on bind mounts.
 * The trade-off (read/write blocking) is irrelevant for a single-user chat app.
 *
 * Runs an integrity_check at startup; on corruption, auto-recovers via
 * sqlite3 .recover (a fast no-op for a healthy DB).
 */
export function openDatabase(dbPath: string): Database.Database {

  // Verify integrity with a read-only probe before reopening in read-write mode.
  // When better-sqlite3 opens a corrupted DB in read-write mode, the constructor
  // may throw an exception without releasing the native file handle (prominent on Windows).
  // If the handle remains, renameSync fails with EBUSY and recoverDatabase
  // cannot move the backup aside. The readonly probe does not validate the header
  // and opens anyway, so close() reliably releases the handle.
  let probe: Database.Database | null = null;
  try {
    probe = new Database(dbPath, { readonly: true, fileMustExist: true });
    const status = probe.pragma("integrity_check", { simple: true });
    probe.close();
    probe = null;
    if (status !== "ok") {
      // Integrity check failed → proceed to recovery (handle released, rename possible).
      return recoverDatabase(dbPath);
    }
  } catch {
    // Probe open or integrity_check failed (e.g. SQLITE_NOTADB).
    // Ensure the handle is released before proceeding to recovery.
    if (probe) {
      try { probe.close(); } catch { /* noop */ }
      probe = null;
    }
    return recoverDatabase(dbPath);
  }

  // Reopen the healthy DB in read-write mode.
  const instance = new Database(dbPath);
  initDatabase(instance);
  return instance;
}

/**
 * Initializes a better-sqlite3 Database instance: applies pragmas, loads sqlite-vec,
 * and runs one-time JSON→BLOB embedding migration if needed.
 * Called from openDatabase (normal path) and recoverDatabase (healed + fresh paths).
 */
function initDatabase(db: Database.Database) {
  db.pragma("journal_mode = DELETE");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);
  // One-time data migration: convert legacy JSON text embeddings to Float32 BLOB.
  // Uses vec_f32() which accepts JSON string input and returns a compact BLOB.
  // Idempotent: typeof(BLOB) = 'blob', not 'text', so the WHERE clause skips already-converted rows.
  const tables = ["memories", "todos", "skills", "page_embeddings", "user_traits"];
  for (const table of tables) {
    try {
      const count = db.prepare(
        `SELECT COUNT(*) as n FROM ${table} WHERE typeof(embedding) = 'text'`
      ).get() as { n: number };
      if (count.n > 0) {
        db.exec(`UPDATE ${table} SET embedding = vec_f32(embedding) WHERE typeof(embedding) = 'text'`);
        logger.info("db", "migrated embeddings to BLOB", { table, rows: count.n });
      }
    } catch {
      // Table might not exist yet on first launch (pre-migration) — skip.
    }
  }
}

const SQLITE_MAGIC = Buffer.from("SQLite format 3\x00");

// Returns true if the first 16 bytes of path match the SQLite magic. Returns false on read failure.
function isSqliteFile(path: string): boolean {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return false; }
  const buf = Buffer.alloc(16);
  const n = readSync(fd, buf, 0, 16, 0);
  closeSync(fd);
  return n >= 16 && buf.subarray(0, 16).equals(SQLITE_MAGIC);
}

// If a deployed bug wrote SQL text to dbPath and moved the real DB to
// *.corrupt-*, attempts to recover from that real DB.
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
  // Select the newest one and verify it has a SQLite header.
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
    // If the file does not exist, etc., continue without creating backupPath.
  }
  for (const ext of ["-wal", "-shm", "-journal"]) {
    try { unlinkSync(dbPath + ext); } catch { /* Ignore if not present */ }
  }
  // .recover outputs SQL text to stdout. Piping .recover output to another
  // sqlite3 process builds a binary DB: `sqlite3 <backup> .recover | sqlite3 <newdb>`.
  // If backupPath is not SQLite (i.e. SQL text from a deployed bug),
  // attempt recovery from the previous real DB backup.
  // Security: use spawnSync (no shell) to prevent shell metacharacter injection
  // from DATABASE_URL. Two-step pipe: capture .recover stdout, feed as stdin.
  let recoverSource = backupPath;
  if (!isSqliteFile(backupPath)) {
    recoverSource = findRealBackup(dbPath, backupPath) ?? backupPath;
  }
  try {
    // Step 1: sqlite3 <recoverSource> .recover → SQL text on stdout
    const recoverProc = spawnSync("sqlite3", [recoverSource, ".recover"], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024, // 512MB — enough for large DBs
    });
    if (recoverProc.status === 0 && recoverProc.stdout) {
      // Step 2: sqlite3 <dbPath> — feed recovered SQL via stdin
      const importProc = spawnSync("sqlite3", [dbPath], {
        input: recoverProc.stdout,
        encoding: "utf8",
      });
      if (importProc.status !== 0) {
        throw new Error(`sqlite3 import failed: ${importProc.stderr || "unknown"}`);
      }
    } else {
      throw new Error(`sqlite3 .recover failed: ${recoverProc.stderr || "unknown"}`);
    }
  } catch {
    // sqlite3 CLI missing or .recover failed → empty new file. Migration rebuilds the schema.
    new Database(dbPath).close();
  }
  try {
    const healed = new Database(dbPath);
    initDatabase(healed);
    logger.warn("db", "Recovered from corruption", { backup: backupPath });
    return healed;
  } catch {
    // If the recovered file cannot be opened, fall back to a fresh empty DB.
    new Database(dbPath).close();
    const fresh = new Database(dbPath);
    initDatabase(fresh);
    logger.warn("db", "Recovery failed; started fresh DB", { backup: backupPath });
    return fresh;
  }
}

const sqlite = globalForDb.sqlite ?? openDatabase(dbPath);

if (process.env.NODE_ENV !== "production") {
  globalForDb.sqlite = sqlite;
}

export const db: Db = globalForDb.db ?? drizzle(sqlite, { schema });
logger.info("db", "opened", { path: dbPath });
if (process.env.NODE_ENV !== "production") {
  globalForDb.db = db;
}
