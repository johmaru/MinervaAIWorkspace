/**
 * scripts/pack-exe.ts — Assemble the standalone distribution package.
 *
 * 1. Generate .next/standalone/ via `bun run build`
 * 2. Copy public/, .next/static/, drizzle/, scripts/, .env.example, and the
 *    launcher into dist/UmansChat/
 * 3. Build umanschat.exe via `bun build --compile` (bundles the Bun runtime)
 *
 * Usage: bun scripts/pack-exe.ts
 */
import { existsSync, mkdirSync, cpSync, writeFileSync, rmSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const distDir = join(root, "dist");
const outDir = join(distDir, "UmansChat");

// Clean up dist/ and .next/ BEFORE build so output-file-tracing does not pick
// up a stale dist/ (which causes recursive dist/UmansChat/dist/... nesting).
// Deleting the entire dist/ (not just dist/UmansChat) ensures the trace sees
// no dist tree at all. .next is cleaned to avoid reusing stale tracing output.
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true });
}
const nextDir = join(root, ".next");
if (existsSync(nextDir)) {
  rmSync(nextDir, { recursive: true, force: true });
}

console.log("[pack] Building standalone server...");
execSync("bun run build", { cwd: root, stdio: "inherit", env: { ...process.env, DATABASE_URL: ":memory:" } });

// Create output directory AFTER build so tracing never sees it.
mkdirSync(outDir, { recursive: true });

console.log("[pack] Copying files...");

// .next/standalone/* → dist/UmansChat/
const standaloneDir = join(root, ".next", "standalone");
if (!existsSync(standaloneDir)) {
  console.error("[pack] .next/standalone not found. Did the build succeed?");
  process.exit(1);
}
// .next/standalone contains junctions created by Next.js's output-file-tracing
// (node_modules/@xenova/transformers-<hash>, better-sqlite3-<hash>).
// On Windows, cpSync tries to copyfile the junctions and hits EPERM, so we
// skip junctions and copy the junction targets as real directories into dist
// after copying. Junctions point to absolute paths, which would break at the
// distribution destination, so this prevents that.
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

// Copy junction targets as real directories (absolute-path junctions break at the distribution destination)
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

// drizzle/ → dist/UmansChat/drizzle/ (for migrations)
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

// package.json → dist/UmansChat/ (required by bun build --compile)
cpSync(
  join(root, "package.json"),
  join(outDir, "package.json"),
);

// node.exe → dist/UmansChat/node.exe (required to spawn server.js at runtime).
// The compiled umanschat.exe bundles the launcher (run via Bun), but the app
// uses better-sqlite3 which Bun does not support. Docker runs `node server.js`,
// so the exe distribution must do the same. Resolve node from PATH so CI and
// local builds use whichever Node is installed.
const nodeExeSrc = execSync("where node", { encoding: "utf8" }).trim().split(/\r?\n/)[0].trim();
if (!nodeExeSrc || !existsSync(nodeExeSrc)) {
  throw new Error("[pack] Cannot find node.exe on PATH. Ensure Node.js is installed.");
}
cpSync(nodeExeSrc, join(outDir, "node.exe"));
console.log("[pack] Copied node.exe for runtime server spawn.");
// Remove test files from the distribution (not needed at runtime, reduces size).
// Next.js's output-file-tracing also copies src/**/*.test.ts(x) into standalone,
// so we clean them up on the dist side too.
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
  // .bat fallback: requires bun; directly runs umanschat.cjs
  writeFileSync(
    join(outDir, "umanschat.bat"),
    "@echo off\r\nbun umanschat.cjs\r\n",
  );
  console.log("[pack] umanschat.bat created (requires Bun on PATH).");
}

console.log(`[pack] Done. Distribution at: ${outDir}`);
console.log("[pack] Double-click umanschat.exe to start UmansChat.");
