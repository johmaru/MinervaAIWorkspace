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
import { existsSync, mkdirSync, cpSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const distDir = join(root, "dist");
const outDir = join(distDir, "UmansChat");

console.log("[pack] Building standalone server...");
execSync("bun run build", { cwd: root, stdio: "inherit" });

// dist/UmansChat/ をクリーンアップ
if (existsSync(outDir)) {
  cpSync(outDir, outDir, { recursive: true }); // no-op, just ensure exists
}
mkdirSync(outDir, { recursive: true });

console.log("[pack] Copying files...");

// .next/standalone/* → dist/UmansChat/
const standaloneDir = join(root, ".next", "standalone");
if (!existsSync(standaloneDir)) {
  console.error("[pack] .next/standalone not found. Did the build succeed?");
  process.exit(1);
}
cpSync(standaloneDir, outDir, { recursive: true });

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
