// @vitest-environment node
import { describe, it, expect } from "vitest";
import { openDatabase } from "./index";
import { mkdtempSync, rmSync, readdirSync, openSync, writeSync, closeSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
// Windows 上の AV が回復直後のバイナリ DB を短時間ロックし rmSync が
// EPERM を投げることがある。簡易リトライで吸収する。
function rmSyncRetry(target: string) {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      // 100ms のビジーウェイトでロック解放を待つ。
      const until = Date.now() + 100;
      while (Date.now() < until) { /* spin */ }
    }
  }
  // 最終試行: 例外は無視（テスト本体の検証は既に成功している前提）。
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
      // 本物の SQLite DB を作成して行を 1 件書き込む。
      const seed = new Database(path);
      seed.exec("CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('hello');");
      seed.close();
      // ヘッダー 16 バイトを破損（SQLite magic を潰す）。
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
