import { join, dirname } from "node:path";

/** @deprecated One-release fallback for pre-rename installs */
const LEGACY_USER_ROOT_ENV = "UMANS_USER_ROOT";
const USER_ROOT_ENV = "MINERVA_USER_ROOT";

/**
 * Returns true when running as the compiled standalone binary.
 * Accepts both the new `minerva` name and the legacy `umanschat` name.
 */
export function isCompiledExe(execPath: string = process.execPath): boolean {
  return (
    execPath.endsWith("minerva.exe") ||
    execPath.endsWith("minerva") ||
    execPath.endsWith("umanschat.exe") ||
    execPath.endsWith("umanschat")
  );
}

/**
 * Returns the user data root directory set by the launcher via MINERVA_USER_ROOT
 * (falls back to legacy UMANS_USER_ROOT), or null when unset (dev/Docker —
 * use traditional path resolution).
 */
export function getUserDataRoot(): string | null {
  return process.env[USER_ROOT_ENV] || process.env[LEGACY_USER_ROOT_ENV] || null;
}

/**
 * Returns the data directory path.
 * When MINERVA_USER_ROOT is set (exe with launcher), returns join(root, "data").
 * When unset, falls back to exe-aware detection matching the prior tunnel.ts behavior:
 * compiled exe → dirname(process.execPath)/data, otherwise cwd/data.
 */
export function getDataDir(): string {
  const root = getUserDataRoot();
  if (root) return join(root, "data");
  const base = isCompiledExe() ? dirname(process.execPath) : process.cwd();
  return join(base, "data");
}
