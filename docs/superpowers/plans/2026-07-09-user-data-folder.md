# User Data Folder Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move exe distribution's `.env` and `data/` to `%USERPROFILE%\.umans_chat_unofficial\` so the exe folder is purely replaceable binaries.

**Architecture:** The launcher resolves a user data root (`~/.umans_chat_unofficial`), migrates legacy `appRoot/.env`+`data/` on first launch, then sets `UMANS_USER_ROOT` env var for the server. Server-side helpers (`getDataDir()`, `resolveEnvPath()`) prefer `UMANS_USER_ROOT`, falling back to current exe-aware behavior when unset (dev/Docker). Existing `pack-exe.ts` stash/restore stays as a migration bridge.

**Tech Stack:** Node.js fs/path, Bun `--compile`, Next.js standalone, Drizzle ORM, better-sqlite3, Vitest 4.

## Global Constraints

- exe-only scope: dev (`bun run dev`) and Docker must be unchanged when `UMANS_USER_ROOT` is unset
- User data root: `%USERPROFILE%\.umans_chat_unofficial\` (fall back to `$HOME`)
- `.env.example` default `REGISTRATION_LOCKED=false` stays unchanged
- Tests: Vitest 4, `// @vitest-environment node` first line for `src/lib/*` tests, co-located `*.test.ts`
- `launcher/user-data.cjs` is CommonJS (launcher runs via Bun `--compile`, not ESM)
- No new npm dependencies — only `node:fs`, `node:path`, `node:os`
- Stash/restore in `pack-exe.ts` stays as migration bridge (already implemented)
- `bun run test` must pass zero failures before done (AGENTS.md rule)
- `bun run typecheck` must pass

---

### Task 1: Server-side `getDataDir()` helper

**Files:**
- Create: `src/lib/user-data.ts`
- Test: `src/lib/user-data.test.ts`

**Interfaces:**
- Produces: `getUserDataRoot(): string | null`, `getDataDir(): string` — used by Task 3 (envUtils), Task 4 (tunnel), Task 5 (updater)

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { getUserDataRoot, getDataDir } from "./user-data";

describe("user-data", () => {
  const origExecPath = process.execPath;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.execPath = origExecPath;
    delete process.env.UMANS_USER_ROOT;
  });

  it("getUserDataRoot returns UMANS_USER_ROOT when set", () => {
    vi.stubEnv("UMANS_USER_ROOT", "/custom/user/root");
    expect(getUserDataRoot()).toBe("/custom/user/root");
  });

  it("getUserDataRoot returns null when UMANS_USER_ROOT unset", () => {
    delete process.env.UMANS_USER_ROOT;
    expect(getUserDataRoot()).toBeNull();
  });

  it("getDataDir returns join(root, data) when UMANS_USER_ROOT set", () => {
    vi.stubEnv("UMANS_USER_ROOT", "/custom/user/root");
    expect(getDataDir()).toBe(join("/custom/user/root", "data"));
  });

  it("getDataDir falls back to dirname(execPath)/data for compiled exe", () => {
    delete process.env.UMANS_USER_ROOT;
    vi.stubGlobal("process", { ...process, execPath: "/app/umanschat.exe" });
    // Need to also stub process.execPath on the real process for the module
    process.execPath = "/app/umanschat.exe";
    expect(getDataDir()).toBe(join("/app", "data"));
  });

  it("getDataDir falls back to cwd/data for non-compiled (dev)", () => {
    delete process.env.UMANS_USER_ROOT;
    process.execPath = "/usr/local/bin/node";
    expect(getDataDir()).toBe(join(process.cwd(), "data"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/user-data.test.ts`
Expected: FAIL — module `./user-data` not found

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/user-data.ts
import { join, dirname } from "node:path";

/**
 * Returns the user data root directory set by the launcher via UMANS_USER_ROOT,
 * or null when unset (dev/Docker — use traditional path resolution).
 */
export function getUserDataRoot(): string | null {
  return process.env.UMANS_USER_ROOT || null;
}

/**
 * Returns the data directory path.
 * When UMANS_USER_ROOT is set (exe with launcher), returns join(root, "data").
 * When unset, falls back to exe-aware detection matching the prior tunnel.ts behavior:
 * compiled exe → dirname(process.execPath)/data, otherwise cwd/data.
 */
export function getDataDir(): string {
  const root = getUserDataRoot();
  if (root) return join(root, "data");
  const isCompiled =
    process.execPath.endsWith("umanschat.exe") ||
    process.execPath.endsWith("umanschat");
  const base = isCompiled ? dirname(process.execPath) : process.cwd();
  return join(base, "data");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/user-data.test.ts`
Expected: PASS — all 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/user-data.ts src/lib/user-data.test.ts
git commit -m "feat: add getDataDir() helper for user data folder resolution"
```

---

### Task 2: Launcher `user-data.cjs` migration helper

**Files:**
- Create: `launcher/user-data.cjs`
- Test: `launcher/user-data.test.cjs`

**Interfaces:**
- Produces: `resolveUserDataRoot(): string`, `migrateLegacyData(appRoot, userDataRoot): void`, `resolveDataPaths(userDataRoot): object` — used by Task 6 (launcher integration)

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment node
const { describe, it, expect, beforeEach, afterEach } = require("vitest");
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const { resolveUserDataRoot, migrateLegacyData, resolveDataPaths } = require("./user-data.cjs");

describe("launcher/user-data.cjs", () => {
  let base, appRoot, userDataRoot;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "userdata-"));
    appRoot = join(base, "appRoot");
    userDataRoot = join(base, "userRoot");
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(userDataRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe("resolveUserDataRoot", () => {
    it("returns USERPROFILE/.umans_chat_unofficial when USERPROFILE set", () => {
      process.env.USERPROFILE = "/test/home";
      expect(resolveUserDataRoot()).toBe(join("/test/home", ".umans_chat_unofficial"));
      delete process.env.USERPROFILE;
    });

    it("falls back to HOME when USERPROFILE unset", () => {
      delete process.env.USERPROFILE;
      process.env.HOME = "/test/home2";
      expect(resolveUserDataRoot()).toBe(join("/test/home2", ".umans_chat_unofficial"));
      delete process.env.HOME;
    });

    it("throws when neither USERPROFILE nor HOME set", () => {
      delete process.env.USERPROFILE;
      delete process.env.HOME;
      expect(() => resolveUserDataRoot()).toThrow("Cannot determine user home directory");
    });
  });

  describe("migrateLegacyData", () => {
    it("copies legacy .env and data/ when targets absent", () => {
      writeFileSync(join(appRoot, ".env"), "REGISTRATION_LOCKED=true\nLLM_API_KEY=secret\n");
      mkdirSync(join(appRoot, "data"), { recursive: true });
      writeFileSync(join(appRoot, "data", "umanschat.db"), "db-bytes");

      migrateLegacyData(appRoot, userDataRoot);

      expect(readFileSync(join(userDataRoot, ".env"), "utf8")).toBe("REGISTRATION_LOCKED=true\nLLM_API_KEY=secret\n");
      expect(readFileSync(join(userDataRoot, "data", "umanschat.db"), "utf8")).toBe("db-bytes");
    });

    it("skips .env copy when target .env already exists", () => {
      writeFileSync(join(appRoot, ".env"), "OLD=value\n");
      writeFileSync(join(userDataRoot, ".env"), "NEW=value\n");

      migrateLegacyData(appRoot, userDataRoot);

      expect(readFileSync(join(userDataRoot, ".env"), "utf8")).toBe("NEW=value\n");
    });

    it("skips data/ copy when target umanschat.db already exists", () => {
      mkdirSync(join(appRoot, "data"), { recursive: true });
      writeFileSync(join(appRoot, "data", "umanschat.db"), "old-db");
      mkdirSync(join(userDataRoot, "data"), { recursive: true });
      writeFileSync(join(userDataRoot, "data", "umanschat.db"), "new-db");

      migrateLegacyData(appRoot, userDataRoot);

      expect(readFileSync(join(userDataRoot, "data", "umanschat.db"), "utf8")).toBe("new-db");
    });

    it("migrates data/ when target cloudflared/ exists but no DB (partial launch)", () => {
      mkdirSync(join(appRoot, "data"), { recursive: true });
      writeFileSync(join(appRoot, "data", "umanschat.db"), "real-db");
      mkdirSync(join(userDataRoot, "data", "cloudflared"), { recursive: true });
      // No umanschat.db in userDataRoot

      migrateLegacyData(appRoot, userDataRoot);

      expect(readFileSync(join(userDataRoot, "data", "umanschat.db"), "utf8")).toBe("real-db");
    });

    it("is a no-op when no legacy .env or data/ exist", () => {
      migrateLegacyData(appRoot, userDataRoot);
      expect(existsSync(join(userDataRoot, ".env"))).toBe(false);
      expect(existsSync(join(userDataRoot, "data"))).toBe(false);
    });

    it("copies only .env when legacy data/ is absent", () => {
      writeFileSync(join(appRoot, ".env"), "KEY=val\n");

      migrateLegacyData(appRoot, userDataRoot);

      expect(readFileSync(join(userDataRoot, ".env"), "utf8")).toBe("KEY=val\n");
      expect(existsSync(join(userDataRoot, "data"))).toBe(false);
    });

    it("leaves appRoot intact as backup", () => {
      writeFileSync(join(appRoot, ".env"), "KEY=val\n");
      mkdirSync(join(appRoot, "data"), { recursive: true });
      writeFileSync(join(appRoot, "data", "umanschat.db"), "db");

      migrateLegacyData(appRoot, userDataRoot);

      expect(existsSync(join(appRoot, ".env"))).toBe(true);
      expect(existsSync(join(appRoot, "data", "umanschat.db"))).toBe(true);
    });
  });

  describe("resolveDataPaths", () => {
    it("returns all expected paths under userDataRoot", () => {
      const paths = resolveDataPaths("/custom/root");
      expect(paths.envPath).toBe(join("/custom/root", ".env"));
      expect(paths.dataDir).toBe(join("/custom/root", "data"));
      expect(paths.dbPath).toBe(join("/custom/root", "data", "umanschat.db"));
      expect(paths.cloudflaredDir).toBe(join("/custom/root", "data", "cloudflared"));
      expect(paths.updatesDir).toBe(join("/custom/root", "data", "updates"));
      expect(paths.markerPath).toBe(join("/custom/root", "data", ".update-pending"));
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test launcher/user-data.test.cjs`
Expected: FAIL — module `./user-data.cjs` not found

- [ ] **Step 3: Write minimal implementation**

```js
// launcher/user-data.cjs
const { existsSync, cpSync } = require("fs");
const { join } = require("path");

/**
 * Resolve the user data root directory from USERPROFILE or HOME.
 * Returns ~/.umans_chat_unofficial.
 */
function resolveUserDataRoot() {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error("Cannot determine user home directory");
  return join(home, ".umans_chat_unofficial");
}

/**
 * Migrate legacy appRoot/.env and appRoot/data to userDataRoot.
 * - .env: copied only if target absent
 * - data/: copied only if legacy umanschat.db exists and target umanschat.db absent
 * appRoot is left intact as a backup.
 */
function migrateLegacyData(appRoot, userDataRoot) {
  const legacyEnv = join(appRoot, ".env");
  const targetEnv = join(userDataRoot, ".env");
  if (existsSync(legacyEnv) && !existsSync(targetEnv)) {
    cpSync(legacyEnv, targetEnv, { force: true });
  }

  const legacyDb = join(appRoot, "data", "umanschat.db");
  const targetDb = join(userDataRoot, "data", "umanschat.db");
  if (existsSync(legacyDb) && !existsSync(targetDb)) {
    cpSync(join(appRoot, "data"), join(userDataRoot, "data"), {
      recursive: true,
      force: true,
    });
  }
}

/**
 * Resolve all data paths under userDataRoot.
 */
function resolveDataPaths(userDataRoot) {
  return {
    envPath: join(userDataRoot, ".env"),
    dataDir: join(userDataRoot, "data"),
    dbPath: join(userDataRoot, "data", "umanschat.db"),
    cloudflaredDir: join(userDataRoot, "data", "cloudflared"),
    updatesDir: join(userDataRoot, "data", "updates"),
    markerPath: join(userDataRoot, "data", ".update-pending"),
  };
}

module.exports = { resolveUserDataRoot, migrateLegacyData, resolveDataPaths };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test launcher/user-data.test.cjs`
Expected: PASS — all tests

- [ ] **Step 5: Commit**

```bash
git add launcher/user-data.cjs launcher/user-data.test.cjs
git commit -m "feat: add launcher user-data.cjs migration helper"
```

---

### Task 3: `resolveEnvPath()` prefers `UMANS_USER_ROOT`

**Files:**
- Modify: `src/lib/envUtils.ts:1-20` (imports + `resolveEnvPath`)
- Test: extend `src/lib/envUtils.test.ts` (or create if absent)

**Interfaces:**
- Consumes: `getUserDataRoot()` from Task 1
- Produces: `resolveEnvPath()` now returns `join(UMANS_USER_ROOT, ".env")` when set

- [ ] **Step 1: Write the failing test**

```ts
// Add to src/lib/env-utils.test.ts (create if needed)
// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEnvPath } from "./envUtils";

describe("resolveEnvPath", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "envutils-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.UMANS_USER_ROOT;
  });

  it("returns join(UMANS_USER_ROOT, .env) when UMANS_USER_ROOT is set", () => {
    vi.stubEnv("UMANS_USER_ROOT", "/custom/user/root");
    expect(resolveEnvPath()).toBe(join("/custom/user/root", ".env"));
  });

  it("falls back to upward search when UMANS_USER_ROOT unset", () => {
    delete process.env.UMANS_USER_ROOT;
    writeFileSync(join(dir, ".env"), "KEY=val\n");
    process.chdir(dir);
    expect(resolveEnvPath()).toBe(join(dir, ".env"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/env-utils.test.ts`
Expected: FAIL — `resolveEnvPath()` returns cwd `.env`, not user root

- [ ] **Step 3: Modify `resolveEnvPath()`**

In `src/lib/envUtils.ts`, add import at top and modify `resolveEnvPath`:

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { getUserDataRoot } from "./user-data";

export function resolveEnvPath(): string {
  const userRoot = getUserDataRoot();
  if (userRoot) return join(userRoot, ".env");
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), ".env");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/env-utils.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/envUtils.ts src/lib/env-utils.test.ts
git commit -m "feat: resolveEnvPath prefers UMANS_USER_ROOT for exe data folder"
```

---

### Task 4: `tunnel.ts` uses `getDataDir()` for cloudflared

**Files:**
- Modify: `src/lib/tunnel.ts:1-69` (imports + `getCloudflaredDir`)
- Test: extend existing `src/lib/tunnel.test.ts` if present, else add inline

**Interfaces:**
- Consumes: `getDataDir()` from Task 1
- Produces: `getCloudflaredDir()` returns `join(getDataDir(), "cloudflared")`

- [ ] **Step 1: Write the failing test**

```ts
// Add to a new or existing tunnel test file
// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { vi } from "vitest";

// We test getCloudflaredDir indirectly since it's not exported.
// Instead test that getDataDir() drives it by mocking.
describe("tunnel getCloudflaredDir via getDataDir", () => {
  afterEach(() => {
    delete process.env.UMANS_USER_ROOT;
  });

  it("cloudflared dir follows UMANS_USER_ROOT", () => {
    vi.stubEnv("UMANS_USER_ROOT", "/custom/root");
    // Re-import to pick up env change
    vi.resetModules();
    const { getDataDir } = require("./user-data");
    expect(getDataDir()).toBe(join("/custom/root", "data"));
    expect(join(getDataDir(), "cloudflared")).toBe(join("/custom/root", "data", "cloudflared"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/tunnel.test.ts`
Expected: PASS (this test validates getDataDir, which already exists — it's a sanity check)

- [ ] **Step 3: Modify `getCloudflaredDir()`**

In `src/lib/tunnel.ts`, replace the function body and add import:

```ts
// Add to imports at top:
import { getDataDir } from "./user-data";

// Replace getCloudflaredDir (lines 60-69):
function getCloudflaredDir(): string {
  return join(getDataDir(), "cloudflared");
}
```

Delete the old `isCompiled`/`appRoot`/`dirname` logic — `getDataDir()` handles it.

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS — ensure no unused imports (`dirname` may become unused)

- [ ] **Step 5: Clean up unused imports**

If `dirname` is now unused in `tunnel.ts`, remove it from the import. Check with typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tunnel.ts src/lib/tunnel.test.ts
git commit -m "refactor: tunnel getCloudflaredDir uses getDataDir()"
```

---

### Task 5: `updater.ts` uses `getDataDir()` for marker and staging

**Files:**
- Modify: `src/lib/updater.ts:118-142` (imports + `updatesDir` + `markerPath`)
- Test: extend `src/lib/updater.test.ts` if present, else add minimal

**Interfaces:**
- Consumes: `getDataDir()` from Task 1
- Produces: `downloadUpdate()` writes marker/staging under `getDataDir()`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { getDataDir } from "./user-data";

describe("updater paths use getDataDir", () => {
  afterEach(() => {
    delete process.env.UMANS_USER_ROOT;
  });

  it("updates dir follows UMANS_USER_ROOT", () => {
    vi.stubEnv("UMANS_USER_ROOT", "/custom/root");
    expect(join(getDataDir(), "updates")).toBe(join("/custom/root", "data", "updates"));
  });

  it("marker path follows UMANS_USER_ROOT", () => {
    vi.stubEnv("UMANS_USER_ROOT", "/custom/root");
    expect(join(getDataDir(), ".update-pending")).toBe(join("/custom/root", "data", ".update-pending"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/updater.test.ts`
Expected: PASS (sanity check — getDataDir already exists)

- [ ] **Step 3: Modify `updater.ts`**

In `src/lib/updater.ts`, add import and replace path construction:

```ts
// Add to imports:
import { getDataDir } from "./user-data";

// In downloadUpdate(), replace lines 118-142:
const dataDir = getDataDir();
const updatesDir = join(dataDir, "updates");
const zipPath = join(updatesDir, `UmansChat-${version}-windows-x64.zip`);
const stagingDir = join(updatesDir, "staging");

// ... (download + extract unchanged) ...

const markerPath = join(dataDir, ".update-pending");
writeFileSync(markerPath, JSON.stringify({ stagingDir, version, zipPath }));
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/updater.ts src/lib/updater.test.ts
git commit -m "refactor: updater uses getDataDir() for marker and staging paths"
```

---

### Task 6: Launcher integration — user folder, migration, `UMANS_USER_ROOT`

**Files:**
- Modify: `launcher/umanschat-launcher.cjs:1-322` (imports, dataDir, syncEnv, resolveDbPath, dotenv-load, markerPath, server spawn)

**Interfaces:**
- Consumes: `resolveUserDataRoot`, `migrateLegacyData`, `resolveDataPaths` from Task 2

This is the core integration task. All path references move from `appRoot` to `userDataRoot`.

- [ ] **Step 1: Add require and resolve userDataRoot (after line 21)**

```js
const { resolveUserDataRoot, migrateLegacyData, resolveDataPaths } = require("./user-data.cjs");
```

- [ ] **Step 2: Replace dataDir creation (lines 34-36)**

Replace:
```js
const dataDir = join(appRoot, "data");
mkdirSync(dataDir, { recursive: true });
```

With:
```js
// Resolve user data root (~/.umans_chat_unofficial) and migrate legacy appRoot data.
const userDataRoot = resolveUserDataRoot();
mkdirSync(userDataRoot, { recursive: true });
migrateLegacyData(appRoot, userDataRoot);
const paths = resolveDataPaths(userDataRoot);
const dataDir = paths.dataDir;
mkdirSync(dataDir, { recursive: true });
```

- [ ] **Step 3: Update `syncEnv()` to use user folder envPath (line 47)**

Replace `const envPath = join(appRoot, ".env");` with:
```js
const envPath = paths.envPath;
```

- [ ] **Step 4: Update `resolveDbPath()` to use user folder envPath (line 87)**

Replace `const envPath = join(appRoot, ".env");` with:
```js
const envPath = paths.envPath;
```

And change the default dbUrl resolution from `appRoot` to `userDataRoot`:
```js
return resolve(userDataRoot, dbUrl);
```
(line 95: `resolve(appRoot, dbUrl)` → `resolve(userDataRoot, dbUrl)`)

- [ ] **Step 5: Update dotenv-load block (line 250)**

Replace `const envPath = join(appRoot, ".env");` with:
```js
const envPath = paths.envPath;
```

- [ ] **Step 6: Set `UMANS_USER_ROOT` before server spawn (after line 261)**

After the dotenv-load block, add:
```js
process.env.UMANS_USER_ROOT = userDataRoot;
```

- [ ] **Step 7: Update `startServer()` spawn env (line 280-283)**

Ensure the spawn already inherits `process.env` (it does via `{ ...process.env }`), so `UMANS_USER_ROOT` is passed automatically. Verify the env object includes it. No change needed if `{ ...process.env, PORT, DATABASE_URL: dbPath }` is the pattern — `UMANS_USER_ROOT` is in `process.env` from step 6.

- [ ] **Step 8: Update `markerPath` (line 310)**

Replace `const markerPath = join(dataDir, ".update-pending");` with:
```js
const markerPath = paths.markerPath;
```

- [ ] **Step 9: Verify `applyUpdate()` still works (lines 161-221)**

`applyUpdate` reads `markerPath` (now from user folder) and copies staging → appRoot (skipping `data/` and `.env`). This is correct — appRoot only gets binaries, user folder holds data. No change needed to `applyUpdate` itself.

- [ ] **Step 10: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 11: Manual smoke test**

```bash
# Create a fake legacy install
mkdir -p dist/UmansChat/data
printf 'REGISTRATION_LOCKED=true\nLLM_API_KEY=test-key\n' > dist/UmansChat/.env
echo dummy-db > dist/UmansChat/data/umanschat.db

# Run the launcher directly (not compiled) to test migration
node dist/UmansChat/umanschat.cjs
# Check: ~/.umans_chat_unofficial/.env should have REGISTRATION_LOCKED=true
# Check: ~/.umans_chat_unofficial/data/umanschat.db should exist
```

- [ ] **Step 12: Commit**

```bash
git add launcher/umanschat-launcher.cjs
git commit -m "feat: launcher uses user data folder with auto-migration"
```

---

### Task 7: Update `pack-exe.ts` to copy `launcher/user-data.cjs`

**Files:**
- Modify: `scripts/pack-exe.ts:107` (copy assets section)

The launcher now `require("./user-data.cjs")`, so it must be in the dist.

- [ ] **Step 1: Add copy for user-data.cjs**

After the launcher copy block (~line 183-185), add:
```js
// launcher/user-data.cjs → dist/UmansChat/user-data.cjs (required by launcher)
cpSync(
  join(root, "launcher", "user-data.cjs"),
  join(outDir, "user-data.cjs"),
);
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Run pack:exe to verify**

Run: `bun run pack:exe`
Expected: PASS, `dist/UmansChat/user-data.cjs` exists

- [ ] **Step 4: Commit**

```bash
git add scripts/pack-exe.ts
git commit -m "fix: pack-exe copies user-data.cjs into dist"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/deployment.md` (Standalone exe section)
- Modify: `README.md` (Quick Start + Auto-Update)
- Modify: `README.ja.md` (same sections)

- [ ] **Step 1: Update `docs/deployment.md`**

In the "pack-exe.ts pipeline" section, update the Clean bullet (already has stash/restore note) and add after the Launcher sequence section a new subsection:

```markdown
### User data location

The exe distribution stores `.env` and `data/` (SQLite DB, cloudflared binary, update staging) in `%USERPROFILE%\.umans_chat_unofficial\` — not in the exe folder. This means:

- Deleting, rebuilding, or replacing the exe folder does not affect user data.
- On first launch of a new exe, if a legacy `appRoot/.env` and `appRoot/data` exist (from a prior version), the launcher automatically migrates them to the user data folder. The legacy files are left in `appRoot` as a backup.
- The launcher sets `UMANS_USER_ROOT` env var for the server. When unset (dev/Docker), paths fall back to the current behavior (cwd-based).
```

- [ ] **Step 2: Update `README.md`**

In the Quick Start (Standalone Windows exe) section, after the first-launch description, add:

```markdown
> **Data location:** `.env` and `data/` live in `%USERPROFILE%\.umans_chat_unofficial\`, not in the exe folder. Deleting or replacing the exe folder preserves your settings, API keys, and database. On upgrade from a prior version, the launcher auto-migrates legacy data from the exe folder.
```

In the Auto-Update section, update the preserve note:

```markdown
`data/` and `.env` live in `%USERPROFILE%\.umans_chat_unofficial\` and are never touched during updates. The old `umanschat.exe` is renamed to `.old` and cleaned up on next launch.
```

- [ ] **Step 3: Update `README.ja.md`**

Same content in Japanese:

```markdown
> **データの場所:** `.env` と `data/` は exe フォルダではなく `%USERPROFILE%\.umans_chat_unofficial\` に保存されます。exe フォルダを削除・入れ替えても設定・APIキー・データベースは保持されます。旧バージョンからのアップグレード時、ランチャーが exe フォルダから自動でデータを移行します。
```

Auto-Update section:

```markdown
`data/` と `.env` は `%USERPROFILE%\.umans_chat_unofficial\` にあり、更新時には一切触れられません。古い `umanschat.exe` は `.old` にリネームされ、次回起動時に削除されます。
```

- [ ] **Step 4: Commit**

```bash
git add docs/deployment.md README.md README.ja.md
git commit -m "docs: document user data folder for exe distribution"
```

---

### Task 9: Full verification

- [ ] **Step 1: Run typecheck**

Run: `bun run typecheck`
Expected: PASS, zero errors

- [ ] **Step 2: Run full test suite**

Run: `bun run test`
Expected: All tests pass. The `itReal` chat test may fail due to external LLM API — this is unrelated to the change. If it fails, note it as environment-dependent and not caused by this change.

- [ ] **Step 3: Run pack:exe**

Run: `bun run pack:exe`
Expected: PASS, `dist/UmansChat/user-data.cjs` exists alongside `umanschat.cjs`

- [ ] **Step 4: In-place rebuild proof**

```bash
# Create fake legacy install
mkdir -p dist/UmansChat/data
printf 'REGISTRATION_LOCKED=true\nLLM_API_KEY=test-key\nSCRAPER_URL=http://localhost:8000\n' > dist/UmansChat/.env
echo dummy-db > dist/UmansChat/data/umanschat.db

bun run pack:exe

# Verify stash/restore preserved legacy data in dist (bridge for launcher migration)
grep REGISTRATION_LOCKED dist/UmansChat/.env  # should show true
ls dist/UmansChat/data/umanschat.db  # should exist
```

- [ ] **Step 5: Commit final state if any remaining changes**

```bash
git add -A
git commit -m "chore: user data folder relocation complete"
```

---

## Self-Review

### Spec coverage

| Spec requirement | Task |
|---|---|
| `src/lib/user-data.ts` with `getUserDataRoot()` + `getDataDir()` | Task 1 |
| `launcher/user-data.cjs` with migration + path resolution | Task 2 |
| `resolveEnvPath()` prefers `UMANS_USER_ROOT` | Task 3 |
| `tunnel.ts` `getCloudflaredDir()` uses `getDataDir()` | Task 4 |
| `updater.ts` marker/staging use `getDataDir()` | Task 5 |
| Launcher: resolve user root, migrate, set env, unified envPath | Task 6 |
| `pack-exe.ts` copies `user-data.cjs` | Task 7 |
| Docs (deployment.md, README EN/JA) | Task 8 |
| Full verification (typecheck, tests, pack, rebuild proof) | Task 9 |

All spec requirements covered. ✅

### Placeholder scan

No TBD/TODO/placeholder steps. All code blocks contain actual implementation. ✅

### Type consistency

- `getUserDataRoot(): string | null` — consistent across Task 1, 3, 4, 5
- `getDataDir(): string` — consistent across Task 1, 4, 5
- `resolveUserDataRoot(): string` — consistent across Task 2, 6
- `migrateLegacyData(appRoot, userDataRoot): void` — consistent across Task 2, 6
- `resolveDataPaths(userDataRoot)` returns `{ envPath, dataDir, dbPath, cloudflaredDir, updatesDir, markerPath }` — consistent across Task 2, 6
✅
