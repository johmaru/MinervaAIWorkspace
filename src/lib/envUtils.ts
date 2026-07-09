import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { getUserDataRoot } from "./user-data";

/**
 * Searches upward from cwd for an existing .env file.
 * Next.js standalone server uses process.chdir to move to /app/.next/standalone,
 * so writing directly under cwd would target a temporary file in the image layer.
 * If not found, returns cwd/.env (fallback for local dev or new file creation).
 */
export function resolveEnvPath(): string {
  const userRoot = getUserDataRoot();
  if (userRoot) return join(userRoot, ".env");
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break; // Reached filesystem root
    dir = parent;
  }
  return resolve(process.cwd(), ".env");
}

/**
 * Escapes a .env value.
 * Wraps all values in double quotes, backslash-escaping internal " / \ / newlines.
 * Newlines are escaped to \n to prevent injection.
 * # / = / spaces are kept inside quotes so dotenv does not misinterpret them.
 * The dotenv parser interprets \n inside "..." as a newline, so this is safe.
 */
export function escapeEnvValue(value: string): string {
  if (value === "") return '""';
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

/**
 * Reads the .env file and updates the specified key values.
 * Values are escaped via escapeEnvValue.
 * Returns: the updated .env content string.
 */
export function updateEnvContent(
  envContent: string,
  updates: Record<string, string>,
): string {
  let content = envContent;
  for (const [key, rawValue] of Object.entries(updates)) {
    const value = escapeEnvValue(rawValue);
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }
  return content;
}

/**
 * Reads .env, updates the specified keys, and writes back.
 * Resolves the .env path via resolveEnvPath.
 */
export function writeEnvUpdates(updates: Record<string, string>): string {
  const envPath = resolveEnvPath();
  let envContent = "";
  try {
    envContent = readFileSync(envPath, "utf8");
  } catch {
    envContent = "";
  }
  const newContent = updateEnvContent(envContent, updates);
  writeFileSync(envPath, newContent);
  return envPath;
}
