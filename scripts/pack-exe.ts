/**
 * scripts/pack-exe.ts — スタンドアロン配布パッケージを組み立てる。
 *
 * 1. bun run build で .next/standalone/ を生成
 * 2. public/, .next/static/, drizzle/, scripts/, .env.example, ランチャーを
 *    dist/UmansChat/ にコピー
 * 3. bun build --compile で umanschat.exe を生成（Bun ランタイム同梱）
 *
 * 使用法: bun scripts/pack-exe.ts
 */
import { existsSync, mkdirSync, cpSync, writeFileSync, rmSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const distDir = join(root, "dist");
const outDir = join(distDir, "UmansChat");

console.log("[pack] Building standalone server...");
execSync("bun run build", { cwd: root, stdio: "inherit", env: { ...process.env, DATABASE_URL: ":memory:" } });

// dist/UmansChat/ をクリーンアップ
if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

console.log("[pack] Copying files...");

// .next/standalone/* → dist/UmansChat/
const standaloneDir = join(root, ".next", "standalone");
if (!existsSync(standaloneDir)) {
  console.error("[pack] .next/standalone not found. Did the build succeed?");
  process.exit(1);
}
// .next/standalone には Next.js の output-file-tracing が作成した junction
// (node_modules/@xenova/transformers-<hash>, better-sqlite3-<hash>) が含まれる。
// Windows で cpSync が junction を copyfile しようとして EPERM になるため、
// junction をスキップし、コピー後に junction のターゲットを実ディレクトリとして
// dist にコピーする。junction は絶対パスを指すため、配布先で壊れるのを防ぐ。
function findJunctions(dir: string, base = ""): { src: string; target: string; rel: string }[] {
  const junctions: { src: string; target: string; rel: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = base ? join(base, entry.name) : entry.name;
    let stat;
    try { stat = lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) {
      junctions.push({ src: full, target: readlinkSync(full), rel });
    } else if (entry.isDirectory()) {
      junctions.push(...findJunctions(full, rel));
    }
  }
  return junctions;
}

const junctions = findJunctions(standaloneDir);
cpSync(standaloneDir, outDir, {
  recursive: true,
  force: true,
  filter: (src) => {
    try { return !lstatSync(src).isSymbolicLink(); } catch { return true; }
  },
});

// junction ターゲットをディレクトリとして実コピー (絶対パス junction は配布先で壊れる)
for (const j of junctions) {
  const linkDest = join(outDir, j.rel);
  mkdirSync(dirname(linkDest), { recursive: true });
  if (!existsSync(linkDest)) {
    cpSync(j.target, linkDest, { recursive: true, dereference: true });
  }
}

// public/ → dist/UmansChat/public/
const publicSrc = join(root, "public");
if (existsSync(publicSrc)) {
  cpSync(publicSrc, join(outDir, "public"), { recursive: true });
}

// .next/static/ → dist/UmansChat/.next/static/
const staticSrc = join(root, ".next", "static");
if (existsSync(staticSrc)) {
  cpSync(staticSrc, join(outDir, ".next", "static"), { recursive: true });
}

// drizzle/ → dist/UmansChat/drizzle/ (マイグレーション用)
const drizzleSrc = join(root, "drizzle");
if (existsSync(drizzleSrc)) {
  cpSync(drizzleSrc, join(outDir, "drizzle"), { recursive: true });
}

// drizzle.config.ts → dist/UmansChat/
cpSync(
  join(root, "drizzle.config.ts"),
  join(outDir, "drizzle.config.ts"),
);

// scripts/sync-env.ts → dist/UmansChat/scripts/
mkdirSync(join(outDir, "scripts"), { recursive: true });
cpSync(
  join(root, "scripts", "sync-env.ts"),
  join(outDir, "scripts", "sync-env.ts"),
);

// .env.example → dist/UmansChat/.env.example
cpSync(
  join(root, ".env.example"),
  join(outDir, ".env.example"),
);

// launcher → dist/UmansChat/umanschat.cjs
cpSync(
  join(root, "launcher", "umanschat-launcher.cjs"),
  join(outDir, "umanschat.cjs"),
);

// package.json → dist/UmansChat/ (bun build --compile に必要)
cpSync(
  join(root, "package.json"),
  join(outDir, "package.json"),
);

// 配布物からテストファイルを削除 (実行不要・サイズ削減)。
// Next.js の output-file-tracing が src/**/*.test.ts(x) も standalone に
// コピーするため、dist 側でも掃除する。
const testPattern = /(\.test\.ts|\.test\.tsx)$/;
function pruneTests(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      pruneTests(full);
    } else if (testPattern.test(entry.name)) {
      rmSync(full, { force: true });
    }
  }
}
pruneTests(outDir);


console.log("[pack] Compiling launcher to umanschat.exe...");
try {
  execSync(
    `bun build --compile "${join(outDir, "umanschat.cjs")}" --outfile "${join(outDir, "umanschat.exe")}"`,
    { cwd: root, stdio: "inherit" },
  );
  console.log("[pack] umanschat.exe created.");
} catch (err) {
  console.error("[pack] bun build --compile failed:", err);
  console.error("[pack] Falling back to .bat launcher (requires Bun on PATH).");
  // .bat フォールバック: bun が必要だが、umanschat.cjs を直接実行
  writeFileSync(
    join(outDir, "umanschat.bat"),
    "@echo off\r\nbun umanschat.cjs\r\n",
  );
  console.log("[pack] umanschat.bat created (requires Bun on PATH).");
}

console.log(`[pack] Done. Distribution at: ${outDir}`);
console.log("[pack] Double-click umanschat.exe to start UmansChat.");
