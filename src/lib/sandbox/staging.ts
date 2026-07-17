/**
 * Staging directory management (spec §7.1 D5).
 *
 * Per-run staging lives under `getDataDir()/sandbox-staging/<runId>/`. The
 * orchestrator writes the user's inline code to a file there and bind-mounts
 * it read-only into the container. The dir is removed after the run, always.
 *
 * Host staging paths NEVER reach the LLM — only the orchestrator uses them.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "@/lib/user-data";
import type { PolicyOk } from "./policy";

const STAGING_DIR_NAME = "sandbox-staging";

/** Root of all sandbox staging dirs: `<dataDir>/sandbox-staging`. */
export function getSandboxStagingRoot(): string {
  return join(getDataDir(), STAGING_DIR_NAME);
}

/** Validate a runId to avoid path traversal / weird chars in dir names. */
function isValidRunId(runId: string): boolean {
  // Hex or base62-style; reject anything with path separators or dots.
  return /^[A-Za-z0-9_-]{4,128}$/.test(runId);
}

/**
 * Create the staging directory for a run: `<root>/<runId>/`.
 * Returns the absolute path. Rejects malformed runIds.
 */
export async function createRunStaging(runId: string): Promise<string> {
  if (!isValidRunId(runId)) {
    throw new Error(`invalid runId: ${JSON.stringify(runId)}`);
  }
  const dir = join(getSandboxStagingRoot(), runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Write the user's code to a file in the staging dir.
 * Filename is chosen by language convention (`main.py`, `main.js`).
 * Returns the absolute path of the written file.
 */
export async function writeRunCode(
  stagingDir: string,
  filename: string,
  code: string,
): Promise<string> {
  // filename is chosen internally per language, not user-supplied; still
  // guard against traversal in case of future misuse.
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new Error(`invalid filename: ${filename}`);
  }
  const filePath = join(stagingDir, filename);
  await mkdir(stagingDir, { recursive: true });
  await writeFile(filePath, code, "utf8");
  return filePath;
}

/**
 * Remove a staging directory. Safe to call twice — missing dirs are ignored.
 * Never throws (errors are swallowed + logged by caller if needed) so that
 * cleanup failures cannot mask the real run result.
 */
export async function removeRunStaging(stagingDir: string): Promise<void> {
  await rm(stagingDir, { recursive: true, force: true });
}

/** Map a policy-approved language to the staging filename. */
export function filenameForLanguage(language: PolicyOk["language"]): string {
  switch (language) {
    case "python":
      return "main.py";
    case "javascript":
      return "main.js";
    default:
      // Unreachable in v0.4 — policy rejects typescript/bash.
      return "main.txt";
  }
}
