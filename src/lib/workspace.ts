import { join, resolve, sep, dirname, relative, isAbsolute } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { getUserDataRoot } from "@/lib/user-data";
import { parseCommandTokens, isAllowedCommand } from "@/lib/commandWhitelist";

/**
 * Per-user workspace isolation.
 *
 * Each user gets their own workspace directory under <dataRoot>/workspace/<userId>/.
 * This prevents cross-user file access: user A cannot read/write/list files
 * in user B's workspace. The userId is threaded through every workspace
 * function call from the chat route's tool handlers.
 *
 * The base workspace directory (<dataRoot>/workspace/) is mounted into the
 * Docker container via WORKSPACE_HOST_PATH in docker-compose.yml. Per-user
 * subdirectories are created on first access.
 */

/**
 * Resolve the workspace root directory for a specific user.
 *
 * Two modes:
 * 1. WORKSPACE_HOST_PATH set (Docker shared mount): returns the mount path
 *    directly (/app/workspace). This is a single-user shared mount — all
 *    logged-in users see the same host folder. Use when you want AI file
 *    tools to operate on an existing project folder.
 * 2. WORKSPACE_HOST_PATH unset (default): returns <dataRoot>/workspace/<userId>/
 *    for per-user isolation. Each user gets their own directory.
 *
 * Creates the directory if it doesn't exist (idempotent).
 */
export function getWorkspaceRoot(userId: string): string {
  // Shared mount mode: WORKSPACE_HOST_PATH is set in .env, docker-compose
  // mounts the host folder to /app/workspace. Return the container-side
  // mount target, not the host path (which doesn't exist inside the container).
  if (process.env.WORKSPACE_HOST_PATH) {
    return "/app/workspace";
  }

  // Per-user isolation mode: <dataRoot>/workspace/<userId>/
  const root = getUserDataRoot();
  const base = root ?? process.cwd();
  const ws = join(base, "workspace", userId);
  mkdirSync(ws, { recursive: true });
  return ws;
}

/**
 * Resolve a path relative to the user's workspace root and verify it stays inside.
 * Throws if the resolved path escapes the workspace (path traversal).
 * Accepts absolute paths inside workspace, or relative paths.
 * Normalizes .. segments before checking.
 * Returns the absolute resolved path.
 */
export function resolveWorkspacePath(relativePath: string, userId: string): string {
  const wsRoot = getWorkspaceRoot(userId);
  // Allow absolute paths that are inside workspace, or relative paths
  const target = resolve(wsRoot, relativePath);
  // Ensure the resolved path is within wsRoot (prevent path traversal).
  // Use path.relative to handle Windows case-insensitivity correctly:
  // if the result starts with '..' or is absolute, the path escaped wsRoot.
  const rel = relative(wsRoot, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path "${relativePath}" is outside the workspace`);
  }
  return target;
}

// readFileSync is capped at 1MB to prevent memory exhaustion on huge files
const MAX_READ_SIZE = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export async function readWorkspaceFile(relativePath: string, userId: string): Promise<string> {
  const abs = resolveWorkspacePath(relativePath, userId);
  const stat = statSync(abs);
  if (stat.size > MAX_READ_SIZE) {
    return `File is too large (${stat.size} bytes, max ${MAX_READ_SIZE}). Showing first ${MAX_READ_SIZE} bytes.\n\n${readFileSync(abs, "utf8").slice(0, MAX_READ_SIZE)}`;
  }
  return readFileSync(abs, "utf8");
}

export async function writeWorkspaceFile(relativePath: string, content: string, userId: string): Promise<string> {
  const abs = resolveWorkspacePath(relativePath, userId);
  // Create parent directories if needed
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return `File written: ${relativePath} (${content.length} bytes)`;
}

export async function listWorkspaceDirectory(relativePath: string, userId: string): Promise<string> {
  const abs = resolveWorkspacePath(relativePath, userId);
  const entries = readdirSync(abs);
  const lines = entries.map(name => {
    const stat = statSync(join(abs, name));
    return `${stat.isDirectory() ? "[DIR]" : "[FILE]"} ${name} (${stat.size} bytes)`;
  });
  return lines.join("\n") || "(empty directory)";
}

export async function runWorkspaceCommand(command: string, userId: string): Promise<string> {
  const tokens = parseCommandTokens(command);
  if (tokens.length === 0) {
    return "Error: empty command";
  }

  const validation = isAllowedCommand(tokens);
  if (!validation.allowed) {
    return `Blocked: ${validation.reason}`;
  }

  const binary = tokens[0];
  if (!binary) return "Error: empty command";
  const args = tokens.slice(1);
  const wsRoot = getWorkspaceRoot(userId);

  // Minimal env: no secrets leaked to child process
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    USERPROFILE: process.env.USERPROFILE ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TZ: process.env.TZ ?? "Asia/Tokyo",
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };

  return new Promise<string>((resolvePromise) => {
    const proc = spawn(binary, args, {
      cwd: wsRoot,
      timeout: COMMAND_TIMEOUT_MS,
      env: safeEnv,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const MAX_OUTPUT = 1024 * 1024; // 1MB cap
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT) + "\n[truncated]";
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT) + "\n[truncated]";
    });
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
