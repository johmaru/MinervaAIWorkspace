import { join, dirname } from "node:path";

/**
 * Returns the user data root directory set by the launcher via UMANS_USER_ROOT,
 * or null when unset (dev/Docker — use traditional path resolution).
 */
export function getUserDataRoot(): string | null {
  return process.env.UMANS_USER_ROOT || null;
}

/**
 * Returns the data directory path.
 * When UMANS_USER_ROOT is set (exe with launcher), returns join(root, "data").
 * When unset, falls back to exe-aware detection matching the prior tunnel.ts behavior:
 * compiled exe → dirname(process.execPath)/data, otherwise cwd/data.
 */
export function getDataDir(): string {
  const root = getUserDataRoot();
  if (root) return join(root, "data");
  const isCompiled =
    process.execPath.endsWith("umanschat.exe") ||
    process.execPath.endsWith("umanschat");
  const base = isCompiled ? dirname(process.execPath) : process.cwd();
  return join(base, "data");
}
