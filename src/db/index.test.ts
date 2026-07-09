// @vitest-environment node
import { describe, it, expect } from "vitest";
import { openDatabase } from "./index";
import { mkdtempSync, rmSync, readdirSync, openSync, writeSync, closeSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
// On Windows, AV may briefly lock a recovered binary DB, causing rmSync to
// throw EPERM. A simple retry absorbs this.
function rmSyncRetry(target: string) {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      // 100ms busy-wait for lock release.
      const until = Date.now() + 100;
      while (Date.now() < until) { /* spin */ }
    }
  }
  // Final attempt: ignore exceptions (test body verification has already succeeded).
  try { rmSync(target, { recursive: true, force: true }); } catch { /* noop */ }
}


// sqlite3 CLI is required for the .recover self-heal path. Skip the
// self-heal test when it is absent (e.g. host without sqlite3) rather
// than fail: the recover catch-branch yields a valid empty DB but no
// backup file, so the backup assertion cannot hold without the CLI.
const hasSqlite3Cli = (() => {
  try {
    execSync("sqlite3 --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const itCli = hasSqlite3Cli ? it : it.skip;

describe("openDatabase", () => {
  it("uses DELETE journal mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "umans-db-"));
    try {
      const db = openDatabase(join(dir, "test.db"));
      const row = db.prepare("PRAGMA journal_mode").get() as {
        journal_mode?: string;
      };
      expect(String(row.journal_mode).toLowerCase()).toBe("delete");
      db.close();
    } finally {
      rmSyncRetry(dir);
    }
  });
  itCli("self-heals a corrupted DB and creates a backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "umans-db-"));
    try {
      const path = join(dir, "corrupt.db");
      // Create a real SQLite DB and write one row.
      const seed = new Database(path);
      seed.exec("CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('hello');");
      seed.close();
      // Corrupt the 16-byte header (destroy the SQLite magic).
      const fd = openSync(path, "r+");
      writeSync(fd, Buffer.alloc(16, 0), 0, 16, 0);
      closeSync(fd);
      const db = openDatabase(path);
      const row = db.prepare("SELECT v FROM t").get() as { v?: string };
      expect(row.v).toBe("hello");
      db.close();
      const backups = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
      expect(backups.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSyncRetry(dir);
    }
  });
});
