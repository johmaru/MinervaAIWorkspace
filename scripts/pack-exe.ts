/**
 * scripts/pack-exe.ts — Assemble the standalone distribution package.
 *
 * 1. Generate .next/standalone/ via `bun run build`
 * 2. Copy public/, .next/static/, drizzle/, scripts/, .env.example, and the
 *    launcher into dist/Minerva/
 * 3. Build minerva.exe via `bun build --compile` (bundles the Bun runtime)
 *
 * Before wiping dist/, stashes the prior dist/Minerva/.env and data/ so an
 * in-place rebuild preserves live user config (REGISTRATION_LOCKED, secrets)
 * and the SQLite DB — matching the in-app updater's preserve contract. See
 * scripts/pack-preserve.ts.
 *
 * Usage: bun scripts/pack-exe.ts
 */
import { existsSync, mkdirSync, cpSync, writeFileSync, rmSync, lstatSync, readlinkSync, readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { stashInstallState, restoreInstallState, applyExeEnvDefaults } from "./pack-preserve";

const root = process.cwd();
const distDir = join(root, "dist");
const outDir = join(distDir, "Minerva");

// Clean up dist/ and .next/ BEFORE build so output-file-tracing does not pick
// up a stale dist/ (which causes recursive dist/Minerva/dist/... nesting).
// Deleting the entire dist/ (not just dist/Minerva) ensures the trace sees
// no dist tree at all. .next is cleaned to avoid reusing stale tracing output.
// Stash the prior dist/Minerva/.env and data/ BEFORE wiping, so an in-place
// rebuild preserves live user config (REGISTRATION_LOCKED, secrets) and the
// SQLite DB — matching the in-app updater's preserve contract. Stash is
// created before the wipe so a copy failure aborts the pack with no data loss.
const prevOutDir = join(distDir, "Minerva");
let stashDir: string | null = null;
if (existsSync(prevOutDir)) {
  stashDir = mkdtempSync(join(tmpdir(), "minerva-pack-preserve-"));
  const stashed = stashInstallState(prevOutDir, stashDir);
  const stashedKeys: string[] = [];
  if (stashed.env) stashedKeys.push(".env");
  if (stashed.data) stashedKeys.push("data/");
  if (stashedKeys.length > 0) {
    console.log(`[pack] Stashed prior install state: ${stashedKeys.join(", ")}`);
  } else {
    // Nothing to preserve — drop the empty temp dir and null the handle so the
    // restore path and finally block treat this as a fresh pack.
    rmSync(stashDir, { recursive: true, force: true });
    stashDir = null;
  }
}

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

// .next/standalone/* → dist/Minerva/
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

// Stub sharp in @xenova/transformers to avoid native binary dependency.
// transformers.js has a top-level `import sharp from 'sharp'` in image.js that
// runs at module load. Even though text embedding never invokes sharp, the import
// itself fails when the native binary (sharp-win32-x64.node + libvips DLLs) and its
// transitive deps (semver, etc.) are missing — which is common in CI/clean installs.
// We overwrite sharp's main entry point (lib/index.js, per package.json "main") with
// a chainable no-op stub. This short-circuits the entire load chain — constructor.js,
// libvips.js, semver, and all method modules are never required. The `import sharp`
// succeeds, transformers loads, and text embedding works without native binaries.
const transformersSharpDir = join(outDir, ".next", "node_modules", "@xenova");
if (existsSync(transformersSharpDir)) {
  for (const entry of readdirSync(transformersSharpDir)) {
    if (!entry.startsWith("transformers-")) continue;
    const sharpEntry = join(transformersSharpDir, entry, "node_modules", "sharp", "lib", "index.js");
    if (existsSync(sharpEntry)) {
      writeFileSync(sharpEntry, [
        "// STUBBED by pack-exe.ts: sharp native binary is not available in the exe distribution.",
        "// transformers.js only uses sharp for image processing; text embedding does not invoke it.",
        "// Replaces the main entry point (package.json 'main') to short-circuit the entire",
        "// load chain (constructor.js → libvips.js → semver → native binary).",
        "// Returns a chainable no-op so `import sharp from 'sharp'` succeeds at module load.",
        "module.exports = () => new Proxy(function () {}, {",
        "  get: () => () => Promise.resolve({}),",
        "});",
      ].join("\n") + "\n");
    }
  }
  console.log("[pack] Stubbed sharp in @xenova/transformers (native binary not needed for text embedding).");
}

// public/ → dist/Minerva/public/
const publicSrc = join(root, "public");
if (existsSync(publicSrc)) {
  cpSync(publicSrc, join(outDir, "public"), { recursive: true });
}

// .next/static/ → dist/Minerva/.next/static/
const staticSrc = join(root, ".next", "static");
if (existsSync(staticSrc)) {
  cpSync(staticSrc, join(outDir, ".next", "static"), { recursive: true });
}

// drizzle/ → dist/Minerva/drizzle/ (for migrations)
const drizzleSrc = join(root, "drizzle");
if (existsSync(drizzleSrc)) {
  cpSync(drizzleSrc, join(outDir, "drizzle"), { recursive: true });
}

// drizzle.config.ts → dist/Minerva/
cpSync(
  join(root, "drizzle.config.ts"),
  join(outDir, "drizzle.config.ts"),
);

// scripts/sync-env.ts → dist/Minerva/scripts/
mkdirSync(join(outDir, "scripts"), { recursive: true });
cpSync(
  join(root, "scripts", "sync-env.ts"),
  join(outDir, "scripts", "sync-env.ts"),
);

// .env.example → dist/Minerva/.env.example
cpSync(
  join(root, ".env.example"),
  join(outDir, ".env.example"),
);

// Restore stashed live .env and data/ (if any), then re-apply exe-only service
// defaults. The user's previous .env is authoritative — it overwrites any
// host/OFT-copied .env from standalone so security keys (REGISTRATION_LOCKED,
// ALLOWED_REGISTRATION_IPS), secrets, and LLM_* survive an in-place rebuild.
// exeDefaults then strips Docker service hostnames (embedder/scraper/searxng)
// that are unreachable in the exe distribution. Stash is removed in a finally so
// a later pack failure does not leave temp dirs forever.
try {
  if (stashDir) {
    restoreInstallState(stashDir, outDir);
    console.log("[pack] Restored prior install state (.env/data) after assemble.");
  }

  // Re-apply exe-only defaults on the restored (or OFT-copied) .env.
  const distEnvPath = join(outDir, ".env");
  if (existsSync(distEnvPath)) {
    const envContent = readFileSync(distEnvPath, "utf8");
    writeFileSync(distEnvPath, applyExeEnvDefaults(envContent));
    console.log("[pack] Sanitized .env for exe environment (Docker service hostnames removed).");
  }
} finally {
  if (stashDir) {
    rmSync(stashDir, { recursive: true, force: true });
  }
}

// launcher → dist/Minerva/minerva.cjs
cpSync(
  join(root, "launcher", "minerva-launcher.cjs"),
  join(outDir, "minerva.cjs"),
);

// launcher/user-data.cjs → dist/Minerva/user-data.cjs (required by launcher)
cpSync(
  join(root, "launcher", "user-data.cjs"),
  join(outDir, "user-data.cjs"),
);

// package.json → dist/Minerva/ (required by bun build --compile)
cpSync(
  join(root, "package.json"),
  join(outDir, "package.json"),
);

// Override version from APP_VERSION env var (set by release workflow).
// The dev placeholder "0.0.0" is replaced with the real release version.
const distPkgPath = join(outDir, "package.json");
const distPkg = JSON.parse(readFileSync(distPkgPath, "utf8"));
distPkg.version = process.env.APP_VERSION || distPkg.version || "0.0.0";
writeFileSync(distPkgPath, JSON.stringify(distPkg, null, 2));
console.log(`[pack] Version set to ${distPkg.version}`);

// node.exe → dist/Minerva/node.exe (required to spawn server.js at runtime).
// The compiled minerva.exe bundles the launcher (run via Bun), but the app
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


console.log("[pack] Compiling launcher to minerva.exe...");
try {
  execSync(
    `bun build --compile "${join(outDir, "minerva.cjs")}" --outfile "${join(outDir, "minerva.exe")}"`,
    { cwd: root, stdio: "inherit" },
  );
  console.log("[pack] minerva.exe created.");
} catch (err) {
  console.error("[pack] bun build --compile failed:", err);
  console.error("[pack] Falling back to .bat launcher (requires Bun on PATH).");
  // .bat fallback: requires bun; directly runs minerva.cjs
  writeFileSync(
    join(outDir, "minerva.bat"),
    "@echo off\r\nbun minerva.cjs\r\n",
  );
  console.log("[pack] minerva.bat created (requires Bun on PATH).");
}

console.log(`[pack] Done. Distribution at: ${outDir}`);
console.log("[pack] Double-click minerva.exe to start MinervaAIWorkspace.");
