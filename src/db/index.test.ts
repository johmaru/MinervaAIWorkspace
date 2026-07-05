// @vitest-environment node
import { describe, it, expect } from "vitest";
import { openDatabase } from "./index";
import { writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
      rmSync(dir, { recursive: true, force: true });
    }
  });

  itCli("self-heals a corrupted DB and creates a backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "umans-db-"));
    try {
      const path = join(dir, "corrupt.db");
      writeFileSync(path, "not a sqlite database");
      const db = openDatabase(path);
      const row = db.prepare("PRAGMA integrity_check").get() as {
        integrity_check?: string;
      };
      expect(String(row.integrity_check).toLowerCase()).toBe("ok");
      db.close();
      const backups = readdirSync(dir).filter((f) =>
        f.includes(".corrupt-"),
      );
      expect(backups.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
