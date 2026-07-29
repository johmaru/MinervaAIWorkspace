/**
 * Pure str_replace edit logic for the `edit_file` tool.
 *
 * Phase 1: exact match only. No fuzzy matching, no hashline anchors.
 * `write_file` remains for new files / full rewrites; `edit_file` is for
 * partial edits of existing files.
 */

import { resolveWorkspacePath } from "@/lib/workspace";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { statSync } from "node:fs";
import {
  outcomeOk,
  outcomeError,
  type ToolOutcome,
} from "@/lib/toolOutcome";

export type EditFileApplyResult =
  | { ok: true; newContent: string; occurrences: number }
  | { ok: false; code: "EDIT_NO_MATCH" | "EDIT_AMBIGUOUS" | "EDIT_EMPTY_OLD"; message: string };

/** Max file size for edit_file (1MB, same as read_file). */
const MAX_EDIT_SIZE = 1024 * 1024;

/**
 * Pure string replacement: count occurrences of oldString in content,
 * replace with newString. Returns a discriminated result.
 */
export function applyEditFile(args: {
  content: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}): EditFileApplyResult {
  const { content, oldString, newString } = args;

  if (!oldString) {
    return {
      ok: false,
      code: "EDIT_EMPTY_OLD",
      message: "old_string must not be empty.",
    };
  }

  // Count occurrences
  let count = 0;
  let idx = 0;
  while (true) {
    const found = content.indexOf(oldString, idx);
    if (found === -1) break;
    count++;
    idx = found + oldString.length;
  }

  if (count === 0) {
    return {
      ok: false,
      code: "EDIT_NO_MATCH",
      message: `old_string not found in file. Copy the exact text from read_file output.`,
    };
  }

  if (count > 1 && !args.replaceAll) {
    return {
      ok: false,
      code: "EDIT_AMBIGUOUS",
      message: `old_string matches ${count} locations. Set replace_all=true to replace all, or include more surrounding context to make it unique.`,
    };
  }

  // Apply replacement
  let newContent: string;
  if (args.replaceAll) {
    newContent = content.split(oldString).join(newString);
  } else {
    // Single match — replace first occurrence only
    const pos = content.indexOf(oldString);
    newContent = content.slice(0, pos) + newString + content.slice(pos + oldString.length);
  }

  return { ok: true, newContent, occurrences: count };
}

/**
 * Workspace I/O wrapper: read file, apply edit, write back.
 * Uses the same path-safety guards as read_file / write_file.
 */
export async function editFileInWorkspace(args: {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  userId: string;
}): Promise<ToolOutcome> {
  const { path, oldString, newString, replaceAll, userId } = args;

  let abs: string;
  try {
    abs = resolveWorkspacePath(path, userId);
  } catch (err) {
    return outcomeError(
      "edit_file",
      `Path error: ${err instanceof Error ? err.message : String(err)}`,
      "Use a path relative to the workspace root.",
    );
  }

  let content: string;
  try {
    const stat = statSync(abs);
    if (stat.size > MAX_EDIT_SIZE) {
      return outcomeError(
        "edit_file",
        `File is too large (${stat.size} bytes, max ${MAX_EDIT_SIZE}).`,
        "Use grep_content to find the relevant section, then edit a smaller old_string.",
      );
    }
    content = readFileSync(abs, "utf8");
  } catch (err) {
    return outcomeError(
      "edit_file",
      `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      "Verify the path exists. Use search_files to locate the file by pattern.",
    );
  }

  const result = applyEditFile({ content, oldString, newString, replaceAll });

  if (!result.ok) {
    const hint =
      result.code === "EDIT_NO_MATCH"
        ? "Re-read the file with read_file and copy the exact snippet as old_string."
        : result.code === "EDIT_AMBIGUOUS"
          ? "Include more surrounding lines in old_string to make it unique, or set replace_all=true."
          : "Provide a non-empty old_string.";
    return outcomeError("edit_file", result.message, hint, result.code);
  }

  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, result.newContent, "utf8");
  } catch (err) {
    return outcomeError(
      "edit_file",
      `Failed to write file: ${err instanceof Error ? err.message : String(err)}`,
      "Check the workspace is writable and the disk has space.",
    );
  }

  const sizeBefore = content.length;
  const sizeAfter = result.newContent.length;
  return outcomeOk(
    "edit_file",
    `Updated ${path}; ${result.occurrences} replacement(s); size ${sizeBefore}→${sizeAfter} bytes`,
    `Edited ${path} (${result.occurrences}x)`,
  );
}
