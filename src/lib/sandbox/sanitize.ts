/**
 * Lightweight output sanitizer for Tier 1 sandbox runs.
 *
 * Per spec §7.1 (Tier 1 light sanitize):
 * - Strip control / non-printing characters except `\n` (0x0A) and `\t` (0x09).
 * - Truncate to a character budget to bound tool-output size.
 * - This is NOT injection classification — only size + control filtering.
 *   Full translation-model attenuation is a Tier 2+ concern (out of v0.4 scope).
 *
 * `maxBytes` in the plan name is interpreted as a character budget for v0.4
 * simplicity (documented here). UTF-16 code units are used, which is a safe
 * upper bound for byte length and avoids multi-byte splitting.
 */

export type SanitizeResult = { text: string; truncated: boolean };

// C0 controls (0x00-0x1F) minus \n (0x0A) and \t (0x09), plus DEL (0x7F),
// plus C1 controls (0x80-0x9F). Stripped globally.
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;

/**
 * Strip control characters and truncate to `maxChars`.
 * Truncation flag is set only when the cleaned string exceeds `maxChars`.
 */
export function sanitizeToolOutput(raw: string, maxChars: number): SanitizeResult {
  const cleaned = raw.replace(CONTROL_RE, "");
  if (cleaned.length > maxChars) {
    return { text: cleaned.slice(0, maxChars), truncated: true };
  }
  return { text: cleaned, truncated: false };
}
