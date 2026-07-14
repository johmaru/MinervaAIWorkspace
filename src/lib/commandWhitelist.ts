/**
 * Command tokenizer and whitelist for run_command tool.
 *
 * Security design:
 * - Tokenizes the command string (shell-like quoting) WITHOUT a shell
 * - Validates the binary name against a read-only whitelist
 * - Blocks code-execution flags (-e, -c, --eval, etc.)
 * - No shell: false spawn — shell metacharacters are inert
 *
 * Threat model: prompt injection causes LLM to call run_command with
 * attacker-crafted input. Goal: prevent arbitrary code execution even
 * if the LLM is fully compromised.
 */

/**
 * Allowed binaries (read-only / info commands only).
 *
 * Excluded by design:
 * - node, bun, python, python3 — can execute arbitrary code via -e/-c
 * - npx, npm — can run arbitrary packages/scripts
 * - env — can execute other commands
 * - curl, wget, nc, ssh — network tools
 * - rm, del, rmdir, rd — destructive
 * - sh, bash, cmd, powershell — shells
 * - eval, exec, source — indirect execution
 */
const ALLOWED_BINARIES = new Set([
  // Version control (read-only subcommands enforced via flag check)
  "git",
  // File listing / info
  "ls", "dir", "pwd", "file",
  // File reading
  "cat", "head", "tail", "less", "more",
  // Search
  "grep", "rg", "find", "ack",
  // Counting
  "wc",
  // Echo (safe: no shell to interpret output)
  "echo",
  // Tree
  "tree",
]);

/**
 * Flags that enable code execution — always blocked.
 * Matches as prefix of any token (e.g. "-e", "-c", "--eval").
 */
const BLOCKED_FLAGS = new Set([
  "-e", "--eval",           // node, bun: code execution
  "-c",                     // python, sh, bash: code execution
  "-exec", "-execdir",      // find: arbitrary command execution
  "--exec", "--execdir",    // find: long-form variants
  "--require",              // node require
  "--import",               // node import
  "-i", "--interactive",    // interactive mode
]);

/**
 * Git subcommands that modify state — blocked.
 * Only read-only git operations are allowed.
 */
const BLOCKED_GIT_SUBCOMMANDS = new Set([
  "add", "commit", "push", "pull", "fetch", "merge", "rebase",
  "reset", "revert", "checkout", "switch", "branch -d", "tag -d",
  "stash", "stash drop", "clean", "rm", "mv", "init", "clone",
  "remote add", "remote remove", "remote set-url",
  "worktree add", "worktree remove", "cherry-pick", "bisect",
]);

export type ValidationResult = {
  allowed: boolean;
  reason?: string;
};

/**
 * Tokenize a command string using shell-like quoting rules.
 * Handles double quotes, single quotes, and backslash escaping.
 * Does NOT interpret shell metacharacters (|, &, ;, >, <, `).
 * Those characters, if present outside quotes, become literal tokens
 * which will fail the whitelist check.
 *
 * @returns Array of tokens (binary + args), or empty array on parse error
 */
export function parseCommandTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      if (inSingleQuote) {
        // In single quotes, backslash is literal
        current += ch;
      } else if (inDoubleQuote) {
        // In double quotes, backslash only escapes " and \
        // Otherwise it's a literal backslash
        const next = input[i + 1];
        if (next === '"' || next === "\\") {
          escaped = true;
        } else {
          current += ch;
        }
      } else {
        escaped = true;
      }
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (/\s/.test(ch) && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  // Unclosed quote — parse error
  if (inSingleQuote || inDoubleQuote) {
    return [];
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Extract the binary name from a token (handles absolute/relative paths).
 * "git" → "git", "/usr/bin/git" → "git", "./node_modules/.bin/tsc" → "tsc"
 */
function extractBinaryName(token: string): string {
  // Handle both / and \ as path separators
  const parts = token.split(/[/\\]/);
  return parts[parts.length - 1].toLowerCase();
}

/**
 * Validate a tokenized command against the whitelist.
 *
 * @param tokens - Token array from parseCommandTokens (binary + args)
 * @returns { allowed: true } or { allowed: false, reason: string }
 */
export function isAllowedCommand(tokens: string[]): ValidationResult {
  if (tokens.length === 0) {
    return { allowed: false, reason: "empty command" };
  }

  const binaryName = extractBinaryName(tokens[0]);

  // 1. Binary must be in the whitelist
  if (!ALLOWED_BINARIES.has(binaryName)) {
    return { allowed: false, reason: `binary "${binaryName}" is not in the allowed list` };
  }

  // 2. Check for blocked flags in any position
  for (let i = 1; i < tokens.length; i++) {
    const flag = tokens[i].toLowerCase();
    if (BLOCKED_FLAGS.has(flag)) {
      return { allowed: false, reason: `flag "${tokens[i]}" is blocked (code execution)` };
    }
  }

  // 3. For git, only read-only subcommands are allowed
  if (binaryName === "git" && tokens.length >= 2) {
    const subcommand = tokens[1].toLowerCase();

    // Check for blocked subcommands
    if (BLOCKED_GIT_SUBCOMMANDS.has(subcommand)) {
      return { allowed: false, reason: `git "${subcommand}" is not allowed (write operation)` };
    }

    // Allow only known read-only subcommands
    const READONLY_GIT_SUBCOMMANDS = new Set([
      "status", "log", "diff", "show", "branch", "blame",
      "remote", "ls-files", "ls-remote", "describe", "tag",
      "rev-parse", "shortlog", "name-rev",
      "reflog", "rev-list", "cat-file", "symbolic-ref",
      "config",
    ]);

    // Special case: "git branch" without -d is allowed (listing)
    // "git tag" without -d is allowed (listing)
    if (!READONLY_GIT_SUBCOMMANDS.has(subcommand)) {
      // Could be "git --version" etc.
      if (subcommand.startsWith("-")) {
        // Flags like --version are OK
      } else {
        return { allowed: false, reason: `git "${subcommand}" is not a recognized read-only subcommand` };
      }
    }

    // git config: only read-only operations allowed
    // --get, --list, -l, --get-all, --get-regexp are read-only
    // --add, --unset, --replace-all, --unset-all are write (blocked)
    // 2+ non-flag args means a value assignment (write)
    if (subcommand === "config") {
      const CONFIG_WRITE_FLAGS = new Set(["--add", "--unset", "--replace-all", "--unset-all"]);
      for (let i = 2; i < tokens.length; i++) {
        const flag = tokens[i].toLowerCase();
        if (CONFIG_WRITE_FLAGS.has(flag)) {
          return { allowed: false, reason: "git config write operations are blocked" };
        }
      }
      // "git config user.name value" = 2+ non-flag args = write
      const nonFlagArgs = tokens.slice(2).filter(t => !t.startsWith("-"));
      if (nonFlagArgs.length > 1) {
        return { allowed: false, reason: "git config write operations are blocked" };
      }
    }

    // Block code-execution flags on git
    for (let i = 2; i < tokens.length; i++) {
      const flag = tokens[i].toLowerCase();
      if (BLOCKED_FLAGS.has(flag)) {
        return { allowed: false, reason: `git flag "${tokens[i]}" is blocked` };
      }
    }
  }

  return { allowed: true };
}
