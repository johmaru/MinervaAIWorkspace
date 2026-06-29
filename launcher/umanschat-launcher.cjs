/**
 * umanschat-launcher.cjs — スタンドアロン配布用ランチャー。
 *
 * 1. アプリルート（server.js のディレクトリ）を解決
 * 2. data/ ディレクトリを確保
 * 3. .env の同期（.env.example の不足キーを追記）
 * 4. Drizzle マイグレーションを実行
 * 5. スタンドアロンサーバーを起動（PORT=3001）
 * 6. サーバー準備完了を待ってブラウザを開く
 * 7. サーバー終了までプロセスを維持
 *
 * bun build --compile で単一 exe にコンパイル可能。
 * その場合 process.execPath は Bun ランタイムを指す。
 */
const { spawn, execSync, exec } = require("child_process");
const { mkdirSync, existsSync, readFileSync, writeFileSync } = require("fs");
const { join, dirname, resolve } = require("path");
const http = require("http");

const PORT = process.env.PORT || "3001";

// アプリルート解決: server.js と同じディレクトリを基準
// bun build --compile でコンパイルされた場合、__dirname は一時展開先になるが、
// server.js は同階層に配置されるため __dirname で正しい。
const appRoot = __dirname;

// 1. data/ ディレクトリ確保
const dataDir = join(appRoot, "data");
mkdirSync(dataDir, { recursive: true });

// 2. .env 同期: .env.example のキーを .env に追記（既存キーは変更しない）
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

// 3. マイグレーション実行: drizzle-orm の migrator をプログラム的に使用
function runMigrations() {
  try {
    const Database = require("better-sqlite3");
    const { drizzle } = require("drizzle-orm/better-sqlite3");
    const { migrate } = require("drizzle-orm/better-sqlite3/migrator");

    // .env から DATABASE_URL を読む（デフォルト: data/umanschat.db）
    let dbUrl = `data/umanschat.db`;
    const envPath = join(appRoot, ".env");
    if (existsSync(envPath)) {
      const envRaw = readFileSync(envPath, "utf8");
      const m = envRaw.match(/^DATABASE_URL=(.+)$/m);
      if (m) dbUrl = m[1].trim().replace(/^["']|["']$/g, "");
    }
    const dbPath = resolve(appRoot, dbUrl);
    mkdirSync(dirname(dbPath), { recursive: true });

    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite);
    const migrationsFolder = join(appRoot, "drizzle");
    if (existsSync(migrationsFolder)) {
      migrate(db, { migrationsFolder });
      console.log("[launcher] Migrations applied.");
    }
    sqlite.close();
  } catch (err) {
    console.error("[launcher] Migration error:", err.message);
    // マイグレーション失敗でも起動を試みる（初回はテーブル作成が必要だが）
  }
}

// 4. サーバー起動準備完了をポーリング
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

// ── メイン処理 ──
console.log("[launcher] UmansChat starting...");
syncEnv();
runMigrations();

// 5. スタンドアロンサーバー起動
// process.execPath: bun build --compile の場合は Bun ランタイム、
// node で実行の場合は node。
// server.js は Node 互換なので、どちらでも動作する。
const serverPath = join(appRoot, "server.js");
const child = spawn(process.execPath, [serverPath], {
  cwd: appRoot,
  env: { ...process.env, PORT },
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

// 6. ブラウザを開く
waitForServer("localhost", Number(PORT))
  .then(() => {
    console.log(`[launcher] Server ready, opening browser at http://localhost:${PORT}`);
    // Windows: start コマンドでデフォルトブラウザを開く
    exec(`start http://localhost:${PORT}`);
  })
  .catch((err) => {
    console.error(`[launcher] ${err.message}`);
  });
