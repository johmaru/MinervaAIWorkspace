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
const MAX_LIST_LINES = 500;
const MAX_SEARCH_RESULTS = 200;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_FILE_BYTES = 512 * 1024;
const MAX_LIST_DEPTH = 6;
const DEFAULT_LIST_DEPTH = 1;

/** Directories skipped during recursive workspace walks (exploration tools). */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
]);

/** Normalize path separators for stable glob matching. */
function toPosixRel(p: string): string {
  return p.split(sep).join("/");
}

/** Expand one level of `{a,b,c}` brace lists (nested braces expanded recursively). */
function expandBraces(glob: string): string[] {
  const m = /\{([^{}]+)\}/.exec(glob);
  if (!m || m.index === undefined) return [glob];
  const before = glob.slice(0, m.index);
  const after = glob.slice(m.index + m[0].length);
  const alts = m[1]!.split(",");
  return alts.flatMap((alt) => expandBraces(before + alt + after));
}

/** Convert a single brace-free glob to a RegExp source (without ^$). */
function globToRegExpSource(glob: string): string {
  const normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  let i = 0;
  let out = "";
  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (ch === "*" && normalized[i + 1] === "*") {
      // ** or **/
      if (normalized[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if ("\\.()+|^$[]{}!".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
    i += 1;
  }
  return out;
}

/**
 * Convert a simple glob (supports *, **, ?, and brace lists) to a RegExp matching
 * POSIX-relative paths. Examples: double-star slash star.ts, Story*.json, *.{ts,tsx}
 */
export function globToRegExp(glob: string): RegExp {
  const expanded = expandBraces(glob);
  if (expanded.length === 1) {
    return new RegExp(`^${globToRegExpSource(expanded[0]!)}$`, "i");
  }
  const alts = expanded.map((g) => globToRegExpSource(g));
  return new RegExp(`^(?:${alts.join("|")})$`, "i");
}

type WalkHit = { abs: string; rel: string; isDir: boolean; size: number };

/**
 * Walk workspace tree under startAbs. relBase is the workspace-relative prefix
 * for startAbs ("" for workspace root). Skips SKIP_DIR_NAMES.
 * maxDepth is the maximum directory depth to descend (0 = only startAbs's children).
 */
function walkWorkspace(
  startAbs: string,
  relBase: string,
  maxDepth: number,
  onHit: (hit: WalkHit) => boolean | void,
): void {
  const stack: { abs: string; rel: string; depth: number }[] = [
    { abs: startAbs, rel: relBase, depth: 0 },
  ];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(cur.abs);
    } catch {
      continue;
    }
    for (const name of names) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      const childAbs = join(cur.abs, name);
      let st;
      try {
        st = statSync(childAbs);
      } catch {
        continue;
      }
      const childRel = cur.rel ? `${cur.rel}/${name}` : name;
      const posixRel = toPosixRel(childRel);
      if (st.isDirectory()) {
        const cont = onHit({ abs: childAbs, rel: posixRel, isDir: true, size: st.size });
        if (cont === false) return;
        // depth 1 means list children only; recurse when next level is still within maxDepth
        if (cur.depth + 1 < maxDepth) {
          stack.push({ abs: childAbs, rel: childRel, depth: cur.depth + 1 });
        }
      } else if (st.isFile()) {
        const cont = onHit({ abs: childAbs, rel: posixRel, isDir: false, size: st.size });
        if (cont === false) return;
      }
    }
  }
}

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

/**
 * List files/dirs under path. depth=1 is flat (default); higher values recurse
 * (max MAX_LIST_DEPTH). Output is capped at MAX_LIST_LINES.
 */
export async function listWorkspaceDirectory(
  relativePath: string,
  userId: string,
  options?: { depth?: number },
): Promise<string> {
  const abs = resolveWorkspacePath(relativePath, userId);
  const rawDepth = options?.depth ?? DEFAULT_LIST_DEPTH;
  const depth = Math.max(1, Math.min(MAX_LIST_DEPTH, Math.floor(rawDepth) || DEFAULT_LIST_DEPTH));
  const baseLabel = relativePath === "." || relativePath === "" ? "." : relativePath.replace(/\\/g, "/");

  if (depth === 1) {
    const entries = readdirSync(abs);
    const lines = entries.map((name) => {
      const stat = statSync(join(abs, name));
      return `${stat.isDirectory() ? "[DIR]" : "[FILE]"} ${name} (${stat.size} bytes)`;
    });
    if (lines.length === 0) {
      return `[LIST empty] path=${baseLabel} (empty directory)`;
    }
    return lines.join("\n");
  }

  const lines: string[] = [];
  let truncated = false;
  walkWorkspace(abs, "", depth, (hit) => {
    if (lines.length >= MAX_LIST_LINES) {
      truncated = true;
      return false;
    }
    lines.push(`${hit.isDir ? "[DIR]" : "[FILE]"} ${hit.rel} (${hit.size} bytes)`);
  });
  if (lines.length === 0) {
    return `[LIST empty] path=${baseLabel} depth=${depth} (no entries)`;
  }
  let out = lines.join("\n");
  if (truncated) {
    out += `\n[truncated] listed ${MAX_LIST_LINES} entries under path=${baseLabel} depth=${depth}`;
  }
  return out;
}

/**
 * Find files by glob pattern under an optional workspace-relative path.
 * Prefer this over repeated list_directory for codebase exploration.
 */
export async function searchWorkspaceFiles(
  pattern: string,
  userId: string,
  options?: { path?: string; maxResults?: number },
): Promise<string> {
  const pat = pattern?.trim();
  if (!pat) return "[SEARCH empty] pattern is required";

  const subPath = options?.path?.trim() || ".";
  const startAbs = resolveWorkspacePath(subPath, userId);
  const maxResults = Math.max(
    1,
    Math.min(MAX_SEARCH_RESULTS, Math.floor(options?.maxResults ?? MAX_SEARCH_RESULTS) || MAX_SEARCH_RESULTS),
  );
  const re = globToRegExp(pat);
  const hits: string[] = [];
  let truncated = false;

  walkWorkspace(startAbs, "", 32, (hit) => {
    if (hit.isDir) return;
    // Match against path relative to the search root AND basename for short patterns like *.json
    const base = hit.rel.includes("/") ? hit.rel.slice(hit.rel.lastIndexOf("/") + 1) : hit.rel;
    if (re.test(hit.rel) || re.test(base)) {
      if (hits.length >= maxResults) {
        truncated = true;
        return false;
      }
      hits.push(hit.rel);
    }
  });

  const rootLabel = subPath === "." || subPath === "" ? "." : subPath.replace(/\\/g, "/");
  if (hits.length === 0) {
    return `[SEARCH empty] No files matched pattern=${JSON.stringify(pat)} under path=${rootLabel}`;
  }
  let out = hits.map((h) => `[FILE] ${h}`).join("\n");
  if (truncated) {
    out += `\n[truncated] showing first ${maxResults} matches for pattern=${JSON.stringify(pat)}`;
  }
  return out;
}

/**
 * Search file contents with a regex (or fixed string). Skips binary/large files
 * and SKIP_DIR_NAMES. Prefer this over list_directory when looking for symbols/fields.
 */
export async function grepWorkspaceContent(
  pattern: string,
  userId: string,
  options?: {
    path?: string;
    glob?: string;
    caseInsensitive?: boolean;
    maxMatches?: number;
    fixedString?: boolean;
  },
): Promise<string> {
  const pat = pattern?.trim();
  if (!pat) return "[GREP empty] pattern is required";

  const subPath = options?.path?.trim() || ".";
  const startAbs = resolveWorkspacePath(subPath, userId);
  const maxMatches = Math.max(
    1,
    Math.min(MAX_GREP_MATCHES, Math.floor(options?.maxMatches ?? MAX_GREP_MATCHES) || MAX_GREP_MATCHES),
  );
  const globRe = options?.glob?.trim() ? globToRegExp(options.glob.trim()) : null;

  let re: RegExp;
  try {
    if (options?.fixedString) {
      const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(escaped, options.caseInsensitive === false ? "" : "i");
    } else {
      re = new RegExp(pat, options?.caseInsensitive === false ? "" : "i");
    }
  } catch (err) {
    return `[GREP error] Invalid regex: ${err instanceof Error ? err.message : String(err)}`;
  }

  const lines: string[] = [];
  let truncated = false;
  let filesScanned = 0;

  walkWorkspace(startAbs, "", 32, (hit) => {
    if (hit.isDir) return;
    if (globRe) {
      const base = hit.rel.includes("/") ? hit.rel.slice(hit.rel.lastIndexOf("/") + 1) : hit.rel;
      if (!globRe.test(hit.rel) && !globRe.test(base)) return;
    }
    if (hit.size > MAX_GREP_FILE_BYTES || hit.size === 0) return;

    let text: string;
    try {
      const buf = readFileSync(hit.abs);
      // Skip likely binary
      if (buf.includes(0)) return;
      text = buf.toString("utf8");
    } catch {
      return;
    }
    filesScanned += 1;
    const fileLines = text.split(/\r?\n/);
    for (let li = 0; li < fileLines.length; li++) {
      const line = fileLines[li]!;
      if (re.test(line)) {
        if (lines.length >= maxMatches) {
          truncated = true;
          return false;
        }
        // Reset lastIndex for global-less regex safety if flags change later
        const snippet = line.length > 240 ? line.slice(0, 240) + "…" : line;
        lines.push(`${hit.rel}:${li + 1}:${snippet}`);
      }
    }
  });

  const rootLabel = subPath === "." || subPath === "" ? "." : subPath.replace(/\\/g, "/");
  if (lines.length === 0) {
    return (
      `[GREP empty] No matches for pattern=${JSON.stringify(pat)} under path=${rootLabel}` +
      (options?.glob ? ` glob=${JSON.stringify(options.glob)}` : "") +
      ` (scanned ${filesScanned} files)`
    );
  }
  let out = lines.join("\n");
  if (truncated) {
    out += `\n[truncated] showing first ${maxMatches} matches`;
  }
  return out;
}

export type WorkspaceEntry = {
  name: string;
  type: "file" | "dir";
  size: number;
};

/**
 * List workspace directory entries as structured JSON (for KB file picker UI).
 * Returns [{ name, type, size }] — safe to serialize for HTTP responses.
 */
export async function listWorkspaceEntries(relativePath: string, userId: string): Promise<WorkspaceEntry[]> {
  const abs = resolveWorkspacePath(relativePath, userId);
  const entries = readdirSync(abs);
  return entries.map((name) => {
    const st = statSync(join(abs, name));
    return { name, type: st.isDirectory() ? "dir" as const : "file" as const, size: st.size };
  });
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
