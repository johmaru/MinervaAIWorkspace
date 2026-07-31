/**
 * scripts/pack-preserve.ts — Preserve live install state across exe rebuilds.
 *
 * pack-exe.ts wipes dist/ before rebuilding. Without preservation, an in-place
 * rebuild discards the user's live .env (REGISTRATION_LOCKED, secrets, etc.)
 * and data/ (SQLite DB). These helpers stash the prior dist/Minerva/.env and
 * data/ to a temp dir before the wipe and restore them after assemble, then
 * re-apply exe-only service defaults so Docker hostnames do not stick.
 *
 * This mirrors the in-app updater's preserve list (launcher applyUpdate skips
 * data/ and .env when copying staging -> appRoot), so pack now matches update
 * for the dist folder.
 */
import { existsSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface StashedState {
  /** True if a prior .env was copied to the stash. */
  env: boolean;
  /** True if a prior data/ tree was copied to the stash. */
  data: boolean;
}

/**
 * Copy a prior install's .env and data/ into stashDir. Only entries that exist
 * are copied. Throws on copy failure — call this BEFORE wiping dist/ so a throw
 * aborts the pack with no data loss.
 */
export function stashInstallState(prevOutDir: string, stashDir: string): StashedState {
  const result: StashedState = { env: false, data: false };

  const envSrc = join(prevOutDir, ".env");
  if (existsSync(envSrc)) {
    cpSync(envSrc, join(stashDir, ".env"), { force: true });
    result.env = true;
  }

  const dataSrc = join(prevOutDir, "data");
  if (existsSync(dataSrc)) {
    cpSync(dataSrc, join(stashDir, "data"), { recursive: true, force: true });
    result.data = true;
  }
  return result;
}

/**
 * Restore stashed .env and data/ into a freshly assembled outDir. The stashed
 * .env overwrites any host/OFT-copied .env from standalone — the user's live
 * config is authoritative. For data/, the existing outDir/data (if any, e.g.
 * leftover from OFT) is removed first so the stashed tree fully replaces it
 * rather than merging and leaving stale files. No file-by-file merge.
 */
export function restoreInstallState(stashDir: string, outDir: string): void {
  const stashedData = join(stashDir, "data");
  if (existsSync(stashedData)) {
    const outData = join(outDir, "data");
    if (existsSync(outData)) {
      rmSync(outData, { recursive: true, force: true });
    }
    cpSync(stashedData, outData, { recursive: true, force: true });
  }

  const stashedEnv = join(stashDir, ".env");
  if (existsSync(stashedEnv)) {
    cpSync(stashedEnv, join(outDir, ".env"), { force: true });
  }
}

/**
 * Exe-only service defaults. The host .env contains Docker service hostnames
 * (embedder/scraper/searxng) and settings unreachable in the exe distribution.
 * Only these seven keys are rewritten; security keys (REGISTRATION_LOCKED,
 * ALLOWED_REGISTRATION_IPS), secrets, AUTH_*, LLM_*, etc. are never touched.
 *
 * Mirrors the previous inline pack-exe behavior: only replaces existing lines,
 * does NOT append missing keys (launcher syncEnv appends new .env.example keys
 * on first launch).
 */
const exeDefaults: Record<string, string> = {
  EMBED_PROVIDER: "local",
  EMBED_MODEL: "Xenova/all-MiniLM-L6-v2",
  EMBED_DIM: "384",
  EMBEDDER_URL: "",
  SCRAPER_URL: "",
  SEARXNG_URL: "",
  DATABASE_URL: "data/minerva.db",
};

/**
 * Pure string transform: replace the seven exe-default keys' values in env
 * content. Only replaces lines that already exist; missing keys are not
 * appended (matches prior pack-exe behavior). Security keys and all other
 * lines pass through unchanged.
 */
export function applyExeEnvDefaults(envContent: string): string {
  let out = envContent;
  for (const [key, val] of Object.entries(exeDefaults)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    const replacement = val ? `${key}=${val}` : `${key}=`;
    if (re.test(out)) {
      out = out.replace(re, replacement);
    }
  }
  return out;
}
