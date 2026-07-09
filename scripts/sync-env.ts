/**
 * scripts/sync-env.ts
 *
 * Traverse .env.example and append any keys missing from .env (with their
 * example values) to the end of .env. Existing keys are never modified.
 *
 * Since the goal is to ensure consistency before startup, exceptions are not
 * caught and are rethrown directly (handled by the caller in predev /
 * docker-entrypoint.sh).
 *
 * The parser uses the same approach as the existing minimal parser in
 * vitest.setup.ts:10-28 (skip # comments, extract KEY=value, strip "..."
 * quotes). The test setup is not suitable for production imports, so we keep
 * this as an independent pure function.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Extract a Map of KEY -> value string from .env.example. */
function parseExample(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    out.set(key, val);
  }
  return out;
}

/**
 * .env has the key already. Both `^KEY=` (an active definition) and
 * `^# KEY=` (a commented-out definition) count as existing. This prevents
 * .env.example's default value from being appended again for a key the user
 * intentionally commented out (env_file / dotenv uses the last definition,
 * so a duplicate would win).
 */
function hasKey(envContent: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(#\\s*)?${escaped}=`, "m").test(envContent);
}

/** Body of sync-env. Returns the list of appended keys (for testing). */
export function syncEnv(
  examplePath: string,
  envPath: string,
  now: Date = new Date(),
): string[] {
  // Do nothing if example is missing (edge case).
  if (!existsSync(examplePath)) {
    console.log("[sync-env] No .env.example found. Skipping.");
    return [];
  }

  const exampleRaw = readFileSync(examplePath, "utf8");
  const exampleMap = parseExample(exampleRaw);

  // Treat as empty string if .env does not exist.
  const envContent = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

  // Collect append candidates.
  const additions: Array<{ key: string; value: string }> = [];
  for (const [key, value] of exampleMap) {
    if (!hasKey(envContent, key)) {
      additions.push({ key, value });
    }
  }

  if (additions.length === 0) {
    console.log("[sync-env] .env is up to date.");
    return [];
  }

  // Append a header comment + the keys to the end.
  const header = `\n# Auto-merged from .env.example (${now.toISOString()})\n`;
  const body = additions
    .map((a) => `${a.key}=${a.value}`)
    .join("\n");
  const tail = envContent.endsWith("\n") || envContent === "" ? "" : "\n";
  const next = envContent + tail + header + body + "\n";
  writeFileSync(envPath, next, "utf8");

  const keys = additions.map((a) => a.key);
  console.log(`[sync-env] Added ${keys.length} key(s): ${keys.join(", ")}`);
  return keys;
}

// Only runs when executed directly. Does not run on import.
// Compares `process.argv[1]` with this file's path so it works on both
// Node and Bun (Bun-specific `import.meta.main` is absent from @types/node,
// so we avoid it).
// `import.meta.url` is only defined for ESM execution. If undefined (e.g. a
// CJS bundle), fall back safely and treat the guard as false.
const scriptUrl = import.meta.url;
const isMain =
  typeof scriptUrl === "string" &&
  scriptUrl.length > 0 &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(scriptUrl);

if (isMain) {
  const cwd = process.cwd();
  syncEnv(resolve(cwd, ".env.example"), resolve(cwd, ".env"));
}
