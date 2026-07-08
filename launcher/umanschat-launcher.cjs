/**
 * umanschat-launcher.cjs — Launcher for the standalone distribution.
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
const { mkdirSync, existsSync, readFileSync, writeFileSync } = require("fs");
const { join, dirname, resolve } = require("path");
const http = require("http");

const PORT = process.env.PORT || "3001";

// appRoot resolution: for a compiled exe, use the directory of process.execPath;
// when running directly under node/bun, use __dirname.
// An exe compiled with bun build --compile may have __dirname point to a temp extraction dir.
const isCompiled = process.execPath.endsWith("umanschat.exe") ||
                   process.execPath.endsWith("umanschat");
const appRoot = isCompiled
  ? dirname(process.execPath)
  : __dirname;

// 1. Ensure the data/ directory exists
const dataDir = join(appRoot, "data");
mkdirSync(dataDir, { recursive: true });

// Absolute path for DATABASE_URL (resolved after .env sync). Shared between
// migrations and server startup so they open the same SQLite file.
// server.js calls process.chdir(__dirname), so a relative path would open a
// different file. An absolute path is independent of the CWD.
let dbPath = null;

// 2. .env sync: append keys from .env.example to .env (existing keys are not modified)
function syncEnv() {
  const examplePath = join(appRoot, ".env.example");
  const envPath = join(appRoot, ".env");
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

// Resolve DATABASE_URL in .env to an absolute path (default: data/umanschat.db).
// server.js changes the CWD via process.chdir(__dirname), so a relative path
// would open a different file than the migration target.
// Using an absolute path relative to appRoot guarantees the same file regardless of CWD.
function resolveDbPath() {
  let dbUrl = `data/umanschat.db`;
  const envPath = join(appRoot, ".env");
  if (existsSync(envPath)) {
    const envRaw = readFileSync(envPath, "utf8");
    const m = envRaw.match(/^DATABASE_URL=(.+)$/m);
    if (m) dbUrl = m[1].trim().replace(/^["']|["']$/g, "");
  }
  // Return :memory: as-is without making it absolute (in-memory DB)
  if (dbUrl === ":memory:") return dbUrl;
  return resolve(appRoot, dbUrl);
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

// ── Main processing ──
console.log("[launcher] UmansChat starting...");
syncEnv();
dbPath = resolveDbPath();
mkdirSync(dirname(dbPath), { recursive: true });
runMigrations();

// 5. Start the standalone server.
// The compiled umanschat.exe runs the launcher via Bun, but the app uses
// better-sqlite3 which Bun does not support. Docker runs `node server.js`,
// so the exe distribution does the same: spawn the bundled node.exe.
const nodeExe = join(appRoot, "node.exe");
if (!existsSync(nodeExe)) {
  console.error(`[launcher] FATAL: node.exe not found at ${nodeExe}`);
  console.error("[launcher] The standalone distribution is incomplete. Please re-download or rebuild.");
  process.exit(1);
}
const serverPath = join(appRoot, "server.js");
const child = spawn(nodeExe, [serverPath], {
  cwd: appRoot,
  env: { ...process.env, PORT, DATABASE_URL: dbPath },
  stdio: "inherit",
});

child.on("error", (err) => {
  console.error("[launcher] Failed to start server:", err.message);
  process.exit(1);
});

child.on("exit", (code) => {
  console.log(`[launcher] Server exited with code ${code}`);
  process.exit(code ?? 0);
});

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
