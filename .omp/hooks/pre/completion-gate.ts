/**
 * Completion Gate — two safety mechanisms for the work-completion-checklist skill.
 *
 * 1. Secret Guard (tool_call): blocks `git add` / `git commit` when filenames
 *    match sensitive patterns (.env*, *.key, *.pem, *.db, *.sqlite*, *secret*,
 *    *credential*). Already-tracked files are exempted (they've been reviewed).
 *
 * 2. Completion Reminder (before_agent_start): at the start of each turn,
 *    checks `git status --short` and push state. If dirty or unpushed, injects
 *    a short reminder. If clean, injects nothing (zero context pollution).
 *
 * This hook does NOT auto-commit. The commit-vs-.gitignore decision stays with
 * the LLM via skill://work-completion-checklist.
 */
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { execSync } from "child_process";

/** Sensitive filename patterns that must never be newly staged. */
const SECRET_PATTERNS = [
  /\.env(\.|$)/i,
  /\.key(\.|$)/i,
  /\.pem(\.|$)/i,
  /\.db(\.|$)/i,
  /\.sqlite[0-9]*(\.|$)/i,
  /secret/i,
  /credential/i,
];

/** Extract filenames from a `git add` command. Returns null if not git add. */
function extractGitAddFiles(command: string): string[] | null {
  const addMatch = command.match(/\bgit\s+add\b(.+)/);
  if (!addMatch) return null;

  const args = addMatch[1].trim();

  // -A, --all, ., -u, --update → can't extract specific files
  if (/^(-A|--all|\.|-u|--update)/.test(args)) return [];

  return args
    .split(/\s+/)
    .filter((f) => f && !f.startsWith("-"))
    .map((f) => f.replace(/^["']|["']$/g, ""));
}

/** Extract filenames from `git commit <files>` (commit with explicit pathspecs, no -a). */
function extractCommitFiles(command: string): string[] | null {
  const commitMatch = command.match(/\bgit\s+commit\b(.+)/);
  if (!commitMatch) return null;

  const rest = commitMatch[1];

  // -a / --all → auto-stages tracked changes, no explicit paths
  if (/\s(-a|--all)\b/.test(rest)) return [];

  // Extract pathspecs: everything after `--` or bare filenames after flags
  // Pattern: git commit -m "msg" -- file1 file2  OR  git commit file1 file2 -m "msg"
  // Simplest: split on `--` and take the part after it if present
  const dashDash = rest.split(/\s--\s/);
  if (dashDash.length > 1) {
    return dashDash[1]
      .trim()
      .split(/\s+/)
      .filter((f) => f.length > 0)
      .map((f) => f.replace(/^["']|["']$/g, ""));
  }

  // No `--` separator — try to find bare filenames (heuristic, may miss edge cases)
  // Skip if there's an -m flag but no pathspec separator — too ambiguous
  return null;
}

/** Check if `git commit -a` / `git commit --all` is used. */
function isCommitAll(command: string): boolean {
  return /\bgit\s+commit\s+.*\b(-a|--all)\b/.test(command);
}

/** Get currently staged filenames (git diff --cached --name-only). */
function getStagedFiles(cwd: string): string[] {
  try {
    const output = execSync("git diff --cached --name-only", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return output.trim().split("\n").filter((f: string) => f.length > 0);
  } catch {
    return [];
  }
}

/** Get all working-tree files that would be staged by `git add -A`. */
function getAllWorkingFiles(cwd: string): string[] {
  try {
    const output = execSync("git status --short --porcelain", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return output
      .trim()
      .split("\n")
      .filter((f: string) => f.length > 3)
      .map((f: string) => f.slice(3).trim());
  } catch {
    return [];
  }
}

/** True if git already tracks this file (it's been reviewed before). */
function gitIsTracked(cwd: string, file: string): boolean {
  try {
    execSync(`git ls-files --error-unmatch -- "${file}"`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export default function (pi: HookAPI): void {
  // ── 1. Secret Guard: block staging of untracked sensitive files ─────

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = String(event.input?.command ?? "");

    // Determine which files the command would stage
    const addFiles = extractGitAddFiles(command);
    const commitFiles = extractCommitFiles(command);

    // Not a git add or git commit → skip
    if (addFiles === null && commitFiles === null && !isCommitAll(command)) return;

    let filesToCheck: string[];

    if (addFiles !== null && addFiles.length > 0) {
      filesToCheck = addFiles;
    } else if (commitFiles !== null && commitFiles.length > 0) {
      filesToCheck = commitFiles;
    } else {
      // -A, --all, ., commit -a → check all working files + staged
      filesToCheck = [...getAllWorkingFiles(ctx.cwd), ...getStagedFiles(ctx.cwd)];
    }

    // Find sensitive files that are NOT already tracked (tracked = reviewed)
    const newSensitive = filesToCheck.filter(
      (f) => SECRET_PATTERNS.some((p) => p.test(f)) && !gitIsTracked(ctx.cwd, f),
    );

    if (newSensitive.length > 0) {
      const fileList = newSensitive.map((f) => `  - ${f}`).join("\n");
      return {
        block: true,
        reason: `Blocked: untracked sensitive files in git staging:\n${fileList}\n\nAdd these to .gitignore or remove from staging. See skill://work-completion-checklist §4.`,
      };
    }
  });

  // ── 2. Completion Reminder: warn on dirty/unpushed state ───────────

  pi.on("before_agent_start", async (_event, ctx) => {
    let status = "";
    try {
      status = execSync("git status --short", {
        cwd: ctx.cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
    } catch {
      return; // not a git repo
    }

    let unpushed = false;
    try {
      const local = execSync("git rev-parse HEAD", {
        cwd: ctx.cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();

      const remote = execSync("git rev-parse @{u}", {
        cwd: ctx.cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();

      unpushed = local !== remote;
    } catch {
      unpushed = true; // no upstream branch
    }

    if (!status && !unpushed) return; // clean → inject nothing

    const issues: string[] = [];
    if (status) {
      const fileCount = status.split("\n").filter((l: string) => l.trim()).length;
      issues.push(`未コミットファイル ${fileCount}件`);
    }
    if (unpushed) issues.push("未push");

    const warning = issues.join(", ");

    ctx.ui.setStatus("completion-gate", `\u26A0 ${warning}`);

    return {
      message: {
        customType: "completion-gate",
        content: `[Completion Gate] ${warning}。yield前に skill://work-completion-checklist を読んでチェックリストを完了してください。git status:\n${status || "(empty)"}`,
        display: "visible",
      },
    };
  });
}
