import { join, resolve, sep, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { getUserDataRoot } from "@/lib/user-data";

/**
 * Resolve the workspace root directory.
 * - UMANS_USER_ROOT set (exe): join(root, "workspace")
 * - Unset (dev): join(cwd, "workspace")
 * Creates the directory if it doesn't exist (idempotent).
 */
export function getWorkspaceRoot(): string {
  const root = getUserDataRoot();
  const base = root ?? process.cwd();
  const ws = join(base, "workspace");
  mkdirSync(ws, { recursive: true });
  return ws;
}

/**
 * Resolve a path relative to the workspace root and verify it stays inside.
 * Throws if the resolved path escapes the workspace (path traversal).
 * Accepts absolute paths inside workspace, or relative paths.
 * Normalizes .. segments before checking.
 * Returns the absolute resolved path.
 */
export function resolveWorkspacePath(relativePath: string): string {
  const wsRoot = getWorkspaceRoot();
  // Allow absolute paths that are inside workspace, or relative paths
  const target = resolve(wsRoot, relativePath);
  // Ensure the resolved path is within wsRoot (prevent path traversal)
  const wsRootNormalized = wsRoot.endsWith(sep) ? wsRoot : wsRoot + sep;
  if (!target.startsWith(wsRootNormalized) && target !== wsRoot) {
    throw new Error(`Path "${relativePath}" is outside the workspace`);
  }
  return target;
}

// readFileSync is capped at 1MB to prevent memory exhaustion on huge files
const MAX_READ_SIZE = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export async function readWorkspaceFile(relativePath: string): Promise<string> {
  const abs = resolveWorkspacePath(relativePath);
  const stat = statSync(abs);
  if (stat.size > MAX_READ_SIZE) {
    return `File is too large (${stat.size} bytes, max ${MAX_READ_SIZE}). Showing first ${MAX_READ_SIZE} bytes.\n\n${readFileSync(abs, "utf8").slice(0, MAX_READ_SIZE)}`;
  }
  return readFileSync(abs, "utf8");
}

export async function writeWorkspaceFile(relativePath: string, content: string): Promise<string> {
  const abs = resolveWorkspacePath(relativePath);
  // Create parent directories if needed
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return `File written: ${relativePath} (${content.length} bytes)`;
}

export async function listWorkspaceDirectory(relativePath: string): Promise<string> {
  const abs = resolveWorkspacePath(relativePath);
  const entries = readdirSync(abs);
  const lines = entries.map(name => {
    const stat = statSync(join(abs, name));
    return `${stat.isDirectory() ? "[DIR]" : "[FILE]"} ${name} (${stat.size} bytes)`;
  });
  return lines.join("\n") || "(empty directory)";
}

export async function runWorkspaceCommand(command: string): Promise<string> {
  const wsRoot = getWorkspaceRoot();
  const isWindows = process.platform === "win32";
  // Windows: cmd.exe /c. Future Linux support: bash -c.
  const shell = isWindows ? "cmd.exe" : "/bin/bash";
  const args = isWindows ? ["/c", command] : ["-c", command];

  return new Promise<string>((resolvePromise) => {
    const proc = spawn(shell, args, {
      cwd: wsRoot,
      timeout: COMMAND_TIMEOUT_MS,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      let result = `Exit code: ${code}\n`;
      if (stdout) result += `--- stdout ---\n${stdout}\n`;
      if (stderr) result += `--- stderr ---\n${stderr}\n`;
      // Truncate if output is too large
      if (result.length > MAX_READ_SIZE) {
        result = result.slice(0, MAX_READ_SIZE) + `\n... (truncated, total ${result.length} chars)`;
      }
      resolvePromise(result);
    });
    proc.on("error", (err) => {
      resolvePromise(`Command execution error: ${err.message}`);
    });
  });
}
