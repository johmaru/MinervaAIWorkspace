/**
 * Provider ID + tool-name prefix resolution.
 *
 * Each provider has a unique tool-name prefix (e.g. "gmail_search" → gmail).
 * The chat route uses resolveProviderFromToolName to find the matching
 * connection row among the thread's enabled connections, so multiple providers
 * can be active simultaneously on one thread.
 */

export type ProviderId =
  | "notion"
  | "gmail"
  | "google_drive"
  | "google_calendar"
  | "github"
  | "outlook"
  | "outlook_calendar";

/** Maps each provider to its tool-name prefix. No two prefixes are prefixes of each other. */
export const TOOL_PREFIX_BY_PROVIDER: Record<ProviderId, string> = {
  notion: "notion_",
  gmail: "gmail_",
  google_drive: "gdrive_",
  google_calendar: "gcal_",
  github: "github_",
  outlook: "outlook_",
  outlook_calendar: "outcal_",
};

/**
 * Resolves the provider for a given tool name by checking each provider's
 * prefix. Returns null for tools that are not connection tools (e.g. sandbox_run).
 *
 * Current prefix set has no collisions; iterate in object order.
 */
export function resolveProviderFromToolName(toolName: string): ProviderId | null {
  for (const [provider, prefix] of Object.entries(TOOL_PREFIX_BY_PROVIDER) as [ProviderId, string][]) {
    if (toolName.startsWith(prefix)) return provider;
  }
  return null;
}

/** Human-readable display label for a provider (for UI lists). */
export const PROVIDER_LABEL: Record<ProviderId, string> = {
  notion: "Notion",
  gmail: "Gmail",
  google_drive: "Google Drive",
  google_calendar: "Google Calendar",
  github: "GitHub",
  outlook: "Outlook",
  outlook_calendar: "Outlook Calendar",
};
