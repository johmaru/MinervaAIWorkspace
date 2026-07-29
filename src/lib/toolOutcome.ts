/**
 * Structured tool outcome envelope.
 *
 * All built-in tool execution results are structured into a ToolOutcome before
 * being serialized to a string for the model. This gives the model:
 * - a clear status (ok / empty / error / blocked / partial)
 * - a one-line summary for compact transcript context
 * - a concrete next-action hint when the outcome is not a clean success
 *
 * Design goal: replace ad-hoc "Failed to read file: ..." / "No results found."
 * plain strings with a deterministic format that nudges the model away from
 * repeating the same failed call.
 */

export type ToolOutcomeStatus = "ok" | "empty" | "error" | "blocked" | "partial";

export type ToolOutcome = {
  tool: string;
  status: ToolOutcomeStatus;
  /** One-line human summary for logs and compact transcript. */
  summary: string;
  /** Body the model should ground on (file content, search hits, error detail, …). */
  body: string;
  /** Concrete next step when status !== ok (or ok-with-caveat). */
  nextHint?: string;
  /** Optional machine codes for tests / metrics. */
  code?: string;
};

/** Max length for an auto-derived summary (body excerpt). */
const MAX_AUTO_SUMMARY = 80;

/** Derive a compact one-line summary from a body string. */
function deriveSummary(body: string): string {
  const firstLine = body.split(/\r?\n/)[0] ?? "";
  if (firstLine.length <= MAX_AUTO_SUMMARY) return firstLine;
  return firstLine.slice(0, MAX_AUTO_SUMMARY - 1) + "…";
}

/**
 * Serialize a ToolOutcome into a deterministic multi-line string for the model.
 *
 * Format:
 * ```
 * [tool=<name> status=<status> code=<code?>]
 * summary: <summary>
 * next: <nextHint if present>
 * ---
 * <body>
 * ```
 */
export function formatToolOutcomeForModel(o: ToolOutcome): string {
  const header = o.code
    ? `[tool=${o.tool} status=${o.status} code=${o.code}]`
    : `[tool=${o.tool} status=${o.status}]`;
  const parts: string[] = [header, `summary: ${o.summary}`];
  if (o.nextHint) {
    parts.push(`next: ${o.nextHint}`);
  }
  parts.push("---");
  parts.push(o.body);
  return parts.join("\n");
}

/** Build an "ok" outcome. Summary is auto-derived from body when omitted. */
export function outcomeOk(tool: string, body: string, summary?: string): ToolOutcome {
  return {
    tool,
    status: "ok",
    summary: summary ?? deriveSummary(body),
    body,
  };
}

/** Build an "empty" outcome. nextHint is required (guides the model to try differently). */
export function outcomeEmpty(
  tool: string,
  summary: string,
  nextHint: string,
  code?: string,
): ToolOutcome {
  return { tool, status: "empty", summary, body: summary, nextHint, code };
}

/** Build an "error" outcome. nextHint is required (prevents retrying identical args). */
export function outcomeError(
  tool: string,
  summary: string,
  nextHint: string,
  code?: string,
): ToolOutcome {
  return { tool, status: "error", summary, body: summary, nextHint, code };
}

/** Build a "blocked" outcome (policy / loop / whitelist). nextHint is required. */
export function outcomeBlocked(
  tool: string,
  summary: string,
  nextHint: string,
  code?: string,
): ToolOutcome {
  return { tool, status: "blocked", summary, body: summary, nextHint, code };
}
