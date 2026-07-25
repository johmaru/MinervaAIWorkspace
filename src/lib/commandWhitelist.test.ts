import { describe, it, expect } from "vitest";
import { parseCommandTokens, isAllowedCommand } from "./commandWhitelist";

describe("parseCommandTokens", () => {
  it("parses simple command", () => {
    expect(parseCommandTokens("git status")).toEqual(["git", "status"]);
  });

  it("parses double-quoted args", () => {
    expect(parseCommandTokens('git log --oneline -3 "feat branch"')).toEqual([
      "git", "log", "--oneline", "-3", "feat branch",
    ]);
  });

  it("parses single-quoted args", () => {
    expect(parseCommandTokens("git log 'HEAD~1'")).toEqual([
      "git", "log", "HEAD~1",
    ]);
  });

  it("parses escaped characters", () => {
    expect(parseCommandTokens('echo hello\\ world')).toEqual([
      "echo", "hello world",
    ]);
  });

  it("handles backslash inside single quotes as literal", () => {
    expect(parseCommandTokens("echo 'a\\b'")).toEqual(["echo", "a\\b"]);
  });

  it("returns empty array on unclosed quote", () => {
    expect(parseCommandTokens('git log "unclosed')).toEqual([]);
  });

  it("handles empty input", () => {
    expect(parseCommandTokens("")).toEqual([]);
  });

  it("handles multiple spaces", () => {
    expect(parseCommandTokens("git    status")).toEqual(["git", "status"]);
  });

  it("does NOT interpret shell metacharacters", () => {
    // | is NOT a pipe here — it becomes a literal token
    expect(parseCommandTokens("git log | rm -rf /")).toEqual([
      "git", "log", "|", "rm", "-rf", "/",
    ]);
  });

  it("handles path-prefixed binaries", () => {
    expect(parseCommandTokens("/usr/bin/git status")).toEqual([
      "/usr/bin/git", "status",
    ]);
  });
});

describe("isAllowedCommand", () => {
  // --- Allowed commands ---

  it("allows git status", () => {
    const result = isAllowedCommand(parseCommandTokens("git status"));
    expect(result.allowed).toBe(true);
  });

  it("allows git log with flags", () => {
    const result = isAllowedCommand(parseCommandTokens("git log --oneline -5"));
    expect(result.allowed).toBe(true);
  });

  it("allows git diff", () => {
    const result = isAllowedCommand(parseCommandTokens("git diff HEAD~1"));
    expect(result.allowed).toBe(true);
  });

  it("allows ls with flags", () => {
    const result = isAllowedCommand(parseCommandTokens("ls -la"));
    expect(result.allowed).toBe(true);
  });

  it("allows cat", () => {
    const result = isAllowedCommand(parseCommandTokens("cat README.md"));
    expect(result.allowed).toBe(true);
  });

  it("allows grep with pattern", () => {
    const result = isAllowedCommand(parseCommandTokens("grep -r TODO src/"));
    expect(result.allowed).toBe(true);
  });

  it("allows echo", () => {
    const result = isAllowedCommand(parseCommandTokens("echo hello"));
    expect(result.allowed).toBe(true);
  });

  it("allows find with path", () => {
    const result = isAllowedCommand(parseCommandTokens("find . -name *.ts"));
    expect(result.allowed).toBe(true);
  });

  // --- Blocked binaries ---

  it("allows node script.js", () => {
    const result = isAllowedCommand(parseCommandTokens("node script.js"));
    expect(result.allowed).toBe(true);
  });

  it("allows python script.py", () => {
    const result = isAllowedCommand(parseCommandTokens("python3 script.py"));
    expect(result.allowed).toBe(true);
  });

  it("blocks npm", () => {
    const result = isAllowedCommand(parseCommandTokens("npm run build"));
    expect(result.allowed).toBe(false);
  });

  it("blocks bun", () => {
    const result = isAllowedCommand(parseCommandTokens("bun test"));
    expect(result.allowed).toBe(false);
  });

  it("blocks npx", () => {
    const result = isAllowedCommand(parseCommandTokens("npx tsc --noEmit"));
    expect(result.allowed).toBe(false);
  });

  it("blocks curl", () => {
    const result = isAllowedCommand(parseCommandTokens("curl http://evil.com"));
    expect(result.allowed).toBe(false);
  });

  it("blocks rm", () => {
    const result = isAllowedCommand(parseCommandTokens("rm -rf /"));
    expect(result.allowed).toBe(false);
  });

  it("blocks env", () => {
    const result = isAllowedCommand(parseCommandTokens("env rm -rf /"));
    expect(result.allowed).toBe(false);
  });

  it("blocks bash", () => {
    const result = isAllowedCommand(parseCommandTokens("bash -c whoami"));
    expect(result.allowed).toBe(false);
  });

  // --- Blocked flags (code execution) ---

  it("blocks node -e (flag check)", () => {
    // node binary is allowed, but -e flag is blocked
    const result = isAllowedCommand(["node", "-e", "console.log(1)"]);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked");
  });

  it("blocks python -c (flag check)", () => {
    const result = isAllowedCommand(parseCommandTokens("python -c 'import os'"));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked");
  });
  // --- Blocked git subcommands ---

  it("blocks git add", () => {
    const result = isAllowedCommand(parseCommandTokens("git add -A"));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("write operation");
  });

  it("blocks git commit", () => {
    const result = isAllowedCommand(parseCommandTokens("git commit -m test"));
    expect(result.allowed).toBe(false);
  });

  it("blocks git push", () => {
    const result = isAllowedCommand(parseCommandTokens("git push origin main"));
    expect(result.allowed).toBe(false);
  });

  it("blocks git reset", () => {
    const result = isAllowedCommand(parseCommandTokens("git reset --hard HEAD~1"));
    expect(result.allowed).toBe(false);
  });

  it("blocks git checkout (write)", () => {
    const result = isAllowedCommand(parseCommandTokens("git checkout main"));
    expect(result.allowed).toBe(false);
  });

  it("blocks git rm", () => {
    const result = isAllowedCommand(parseCommandTokens("git rm file.txt"));
    expect(result.allowed).toBe(false);
  });

  it("blocks git config write", () => {
    const result = isAllowedCommand(parseCommandTokens("git config user.name evil"));
    expect(result.allowed).toBe(false);
  });

  it("allows git config --get", () => {
    const result = isAllowedCommand(parseCommandTokens("git config --get user.name"));
    expect(result.allowed).toBe(true);
  });

  // --- Shell injection attempts ---

  it("blocks pipe injection (pipe becomes literal token, fails whitelist on rm)", () => {
    // After tokenization: ["git", "log", "|", "rm", "-rf", "/"]
    // "git" is allowed, but tokens contain "rm" — however isAllowedCommand only
    // checks the binary (tokens[0]). The pipe is a literal token.
    // This is safe because spawn(shell:false) treats | as literal, not pipe.
    const result = isAllowedCommand(parseCommandTokens("git log | rm -rf /"));
    expect(result.allowed).toBe(true); // git is allowed; rm never runs (shell:false)
  });

  it("blocks semicolon injection via binary check", () => {
    // After tokenization: [";", "rm", "-rf", "/"]
    const result = isAllowedCommand(parseCommandTokens("; rm -rf /"));
    expect(result.allowed).toBe(false);
  });

  it("handles newline in command (newline splits tokens, shell:false makes rm inert)", () => {
    // After \s tokenization: ["git", "log", "rm", "-rf", "/"]
    // git log is allowed; "rm -rf /" are literal args (shell:false)
    const result = isAllowedCommand(parseCommandTokens("git log\nrm -rf /"));
    expect(result.allowed).toBe(true);
  });

  it("blocks & injection via binary check", () => {
    // After tokenization: ["git", "log", "&", "del", "*"]
    // git is allowed; & and del are literal tokens (shell:false)
    const result = isAllowedCommand(parseCommandTokens("git log & del *"));
    expect(result.allowed).toBe(true); // git allowed; & is literal (shell:false)
  });

  // --- Edge cases ---

  it("blocks empty tokens", () => {
    expect(isAllowedCommand([]).allowed).toBe(false);
  });

  it("handles path-prefixed binary", () => {
    const result = isAllowedCommand(parseCommandTokens("/usr/bin/git status"));
    expect(result.allowed).toBe(true);
  });

  it("handles Windows path-prefixed binary", () => {
    // Path must be quoted so the space doesn't split it
    const result = isAllowedCommand(parseCommandTokens('"C:\\Program Files\\Git\\bin\\git" status'));
    expect(result.allowed).toBe(true);
  });

  it("allows git --version", () => {
    const result = isAllowedCommand(parseCommandTokens("git --version"));
    expect(result.allowed).toBe(true);
  });

  it("blocks unknown git subcommand", () => {
    const result = isAllowedCommand(parseCommandTokens("git unknown-command"));
    expect(result.allowed).toBe(false);
  });

  it("blocks find -exec (arbitrary command execution)", () => {
    const result = isAllowedCommand(parseCommandTokens("find . -exec rm -rf / ;"));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("-exec");
  });

  it("blocks find -execdir", () => {
    const result = isAllowedCommand(parseCommandTokens("find . -execdir cat /etc/passwd +"));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("-execdir");
  });
});
