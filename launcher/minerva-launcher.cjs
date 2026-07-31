/**
 * minerva-launcher.cjs — Launcher for the standalone distribution.
 *
 * 1. Resolve the app root (the directory of server.js)
 * 2. Ensure the data/ directory exists
 * 3. Sync .env (append any missing keys from .env.example)
 * 4. Run Drizzle migrations
 * 5. Start the standalone server (PORT=3001)
 * 6. Wait for the server to be ready, then open the browser
 * 7. Keep the process alive until the server exits
 *
 * Can be compiled into a single exe via bun build --compile.
 * The compiled exe runs this launcher via the embedded Bun runtime.
 * The launcher runs migrations via bun:sqlite, then spawns a bundled
 * node.exe to execute server.js (the app uses better-sqlite3, which Bun
 * does not support — Docker runs `node server.js` for parity).
 */
const { spawn, exec } = require("child_process");
const { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, cpSync, rmSync, renameSync, unlinkSync } = require("fs");
const { join, dirname, resolve } = require("path");
const http = require("http");
const { resolveUserDataRoot, migrateLegacyData, resolveDataPaths } = require("./user-data.cjs");

const PORT = process.env.PORT || "3001";

// appRoot resolution: for a compiled exe, use the directory of process.execPath;
// when running directly under node/bun, use __dirname.
// An exe compiled with bun build --compile may have __dirname point to a temp extraction dir.
const isCompiled = process.execPath.endsWith("minerva.exe") ||
                   process.execPath.endsWith("minerva");
const appRoot = isCompiled
  ? dirname(process.execPath)
  : __dirname;

// 1. Resolve user data root (~/.minerva_ai_workspace) and migrate legacy appRoot data.
// The exe folder becomes purely application binaries — safe to delete/replace.
// On first launch with legacy appRoot/.env + appRoot/data, copies them to user folder.
const userDataRoot = resolveUserDataRoot();
mkdirSync(userDataRoot, { recursive: true });
migrateLegacyData(appRoot, userDataRoot);
const paths = resolveDataPaths(userDataRoot);
const dataDir = paths.dataDir;
mkdirSync(dataDir, { recursive: true });

// Absolute path for DATABASE_URL (resolved after .env sync). Shared between
// migrations and server startup so they open the same SQLite file.
// server.js calls process.chdir(__dirname), so a relative path would open a
// different file. An absolute path is independent of the CWD.
let dbPath = null;

// 2. .env sync: append keys from .env.example to .env (existing keys are not modified)
function syncEnv() {
  const examplePath = join(appRoot, ".env.example");
  const envPath = paths.envPath;
  if (!existsSync(examplePath)) return;

  const exampleRaw = readFileSync(examplePath, "utf8");
  const exampleKeys = new Map();
  for (const line of exampleRaw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) exampleKeys.set(key, val);
  }

  let envContent = "";
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, "utf8");
  }

  const hasKey = (key) => new RegExp(`^${key}=`, "m").test(envContent);
  let appended = [];
  for (const [key, val] of exampleKeys) {
    if (!hasKey(key)) {
      envContent += `${envContent && !envContent.endsWith("\n") ? "\n" : ""}${key}=${val}`;
      appended.push(key);
    }
  }
  if (appended.length > 0) {
    writeFileSync(envPath, envContent);
    console.log(`[launcher] Synced .env keys: ${appended.join(", ")}`);
  }
}

// Resolve DATABASE_URL in .env to an absolute path (default: data/minerva.db).
// server.js changes the CWD via process.chdir(__dirname), so a relative path
// would open a different file than the migration target.
// Using an absolute path relative to appRoot guarantees the same file regardless of CWD.
function resolveDbPath() {
  let dbUrl = `data/minerva.db`;
  const envPath = paths.envPath;
  if (existsSync(envPath)) {
    const envRaw = readFileSync(envPath, "utf8");
    const m = envRaw.match(/^DATABASE_URL=(.+)$/m);
    if (m) dbUrl = m[1].trim().replace(/^["']|["']$/g, "");
  }
  // Return :memory: as-is without making it absolute (in-memory DB)
  if (dbUrl === ":memory:") return dbUrl;
  return resolve(userDataRoot, dbUrl);
}

// 3. Run migrations: use drizzle-orm's bun-sqlite migrator (no native addon).
// better-sqlite3 is a native addon that cannot be loaded from inside a
// bun build --compile exe (bindings resolves to a virtual B:/~BUN/root path).
// bun:sqlite is built into the Bun runtime and bundles cleanly.
function runMigrations() {
  try {
    const { Database } = require("bun:sqlite");
    const { drizzle } = require("drizzle-orm/bun-sqlite");
    const { migrate } = require("drizzle-orm/bun-sqlite/migrator");

    // Use the module-scope dbPath (resolved by resolveDbPath after .env sync)
    if (!dbPath) dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });

    const sqlite = new Database(dbPath);
    sqlite.exec("PRAGMA journal_mode = WAL;");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    const db = drizzle(sqlite);
    const migrationsFolder = join(appRoot, "drizzle");
    if (existsSync(migrationsFolder)) {
      migrate(db, { migrationsFolder });
      console.log("[launcher] Migrations applied.");
    }
    sqlite.close();
  } catch (err) {
    console.error("[launcher] Migration error:", err.message);
    // Attempt startup even if migration fails (first run needs table creation, though)
  }
}

// 4. Poll until the server is ready
function waitForServer(host, port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://${host}:${port}/`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error("Server did not start within timeout"));
        } else {
          setTimeout(check, 500);
        }
      });
      req.setTimeout(2000, () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error("Server did not start within timeout"));
        } else {
          setTimeout(check, 500);
        }
      });
    };
    check();
  });
}

// ── Update application ──
// Reads the marker file written by /api/update POST, swaps files from
// staging into appRoot (preserving data/ and .env), replaces minerva.exe
// (rename-running → copy-new), then spawns the new exe and exits.
async function applyUpdate() {
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  const stagingDir = marker.stagingDir;

  if (!existsSync(stagingDir)) {
    throw new Error("Staging directory not found: " + stagingDir);
  }

  console.log("[launcher] Applying update", marker.version, "...");

  // 1. Stop the child node.exe (graceful, then force)
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  // 2. Copy all files from staging to appRoot (skip data/ and .env)
  const entries = readdirSync(stagingDir);
  for (const entry of entries) {
    if (entry === "data" || entry === ".env") continue;
    if (entry === "minerva.exe") continue; // Handle separately
    const src = join(stagingDir, entry);
    const dst = join(appRoot, entry);
    cpSync(src, dst, { recursive: true, force: true });
    console.log("[launcher] Updated:", entry);
  }

  // 3. Replace minerva.exe (can't overwrite running exe → rename + copy)
  const exePath = join(appRoot, "minerva.exe");
  const oldExePath = join(appRoot, "minerva.exe.old");
  const newExePath = join(stagingDir, "minerva.exe");
  if (existsSync(newExePath)) {
    // Rename running exe (Windows allows renaming a running exe)
    if (existsSync(oldExePath)) unlinkSync(oldExePath);
    renameSync(exePath, oldExePath);
    cpSync(newExePath, exePath);
    console.log("[launcher] Replaced minerva.exe");
  }

  // 4. Delete marker file
  unlinkSync(markerPath);

  // 5. Spawn new minerva.exe (detached — survives parent exit)
  const newProc = spawn(exePath, [], {
    detached: true,
    stdio: "ignore",
    cwd: appRoot,
  });
  newProc.unref();
  console.log("[launcher] Update complete. New process started.");

  // 6. Exit current process
  process.exit(0);
}

// ── Main processing ──
console.log("[launcher] MinervaAIWorkspace starting...");
// Clean up old exe from a previous update (Windows can't delete a running exe,
// so the old one is renamed to .old and deleted on next startup)
const oldExe = join(appRoot, "minerva.exe.old");
if (existsSync(oldExe)) {
  try {
    unlinkSync(oldExe);
    console.log("[launcher] Cleaned up minerva.exe.old");
  } catch (err) {
    console.warn("[launcher] Could not delete minerva.exe.old:", err.message);
  }
}
syncEnv();
dbPath = resolveDbPath();
mkdirSync(dirname(dbPath), { recursive: true });
runMigrations();

// Load .env into process.env (Next.js standalone doesn't load .env in production).
// The server inherits process.env via spawn({ env: { ...process.env } }),
// so .env values (EMBED_PROVIDER, EMBEDDER_URL, LLM_API_KEY, etc.) must be
// loaded here before spawning the server.
// Uses inline parsing instead of @next/env (Bun --compile doesn't resolve
// external packages at runtime the same way Node does).
// .env values always override inherited system env — the dist .env is the
// authoritative config for the exe distribution (e.g., EMBED_PROVIDER=local
// must override a leaked EMBED_PROVIDER=http from a Docker/dev session).
const envPath = paths.envPath;
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key) process.env[key] = val;
  }
}

// Set MINERVA_USER_ROOT so the server (and its helpers getDataDir/resolveEnvPath)
// locate .env, data/, cloudflared, and update staging in the user folder.
process.env.MINERVA_USER_ROOT = userDataRoot;

// 5. Start the standalone server.
// The compiled minerva.exe runs the launcher via Bun, but the app uses
// better-sqlite3 which Bun does not support. Docker runs `node server.js`,
// so the exe distribution does the same: spawn the bundled node.exe.
const nodeExe = join(appRoot, "node.exe");
if (!existsSync(nodeExe)) {
  console.error(`[launcher] FATAL: node.exe not found at ${nodeExe}`);
  console.error("[launcher] The standalone distribution is incomplete. Please re-download or rebuild.");
  process.exit(1);
}
const serverPath = join(appRoot, "server.js");

let updating = false;
let child = null;

/** Spawn node.exe server.js and attach the exit handler. Reusable after update recovery. */
function startServer() {
  child = spawn(nodeExe, [serverPath], {
    cwd: appRoot,
    env: { ...process.env, PORT, DATABASE_URL: dbPath, MINERVA_USER_ROOT: userDataRoot },
    stdio: "inherit",
  });
  child.on("error", (err) => {
    console.error("[launcher] Failed to start server:", err.message);
    process.exit(1);
  });
  child.on("exit", (code) => {
    if (updating) return; // Don't exit during update — applyUpdate handles lifecycle
    console.log(`[launcher] Server exited with code ${code}`);
    process.exit(code ?? 0);
  });
}

startServer();

// 6. Open the browser
waitForServer("localhost", Number(PORT))
  .then(() => {
    console.log(`[launcher] Server ready, opening browser at http://localhost:${PORT}`);
    // Windows: open the default browser via the start command
    exec(`start http://localhost:${PORT}`);
  })
  .catch((err) => {
    console.error(`[launcher] ${err.message}`);
  });

// 7. Poll for update marker every 5 seconds
const markerPath = paths.markerPath;
const updateInterval = setInterval(() => {
  if (!updating && existsSync(markerPath)) {
    updating = true;
    clearInterval(updateInterval);
    applyUpdate().catch((err) => {
      console.error("[launcher] Update failed:", err.message);
      try { unlinkSync(markerPath); } catch {}
      updating = false;
      startServer(); // Restart server with old files
    });
  }
}, 5000);
