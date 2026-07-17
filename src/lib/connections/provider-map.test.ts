// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  PROVIDER_LABEL,
  resolveProviderFromToolName,
  TOOL_PREFIX_BY_PROVIDER,
  type ProviderId,
} from "./provider-map";

describe("resolveProviderFromToolName", () => {
  const cases: Array<[string, ProviderId | null]> = [
    ["notion_search", "notion"],
    ["notion_get_page", "notion"],
    ["notion_get_blocks", "notion"],
    ["gmail_search", "gmail"],
    ["gmail_get_message", "gmail"],
    ["gmail_list_labels", "gmail"],
    ["gdrive_search", "google_drive"],
    ["gdrive_get_metadata", "google_drive"],
    ["gdrive_export_text", "google_drive"],
    ["gcal_list_calendars", "google_calendar"],
    ["gcal_list_events", "google_calendar"],
    ["gcal_create_event", "google_calendar"],
    ["github_search_repos", "github"],
    ["github_list_issues", "github"],
    ["github_get_file", "github"],
    ["github_search_code", "github"],
    ["outlook_search", "outlook"],
    ["outlook_get_message", "outlook"],
    ["outlook_list_folders", "outlook"],
    ["outcal_list_calendars", "outlook_calendar"],
    ["outcal_list_events", "outlook_calendar"],
    ["outcal_create_event", "outlook_calendar"],
    // negatives
    ["sandbox_run", null],
    ["search_web", null],
    ["read_file", null],
    ["", null],
    ["notion", null],
    ["gmail", null],
    ["github", null],
    ["outlook", null],
  ];
  for (const [name, expected] of cases) {
    it(`resolves "${name}" → ${expected}`, () => {
      expect(resolveProviderFromToolName(name)).toBe(expected);
    });
  }

  it("every provider prefix is unique", () => {
    const prefixes = Object.values(TOOL_PREFIX_BY_PROVIDER);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("no prefix is a prefix of another prefix", () => {
    const prefixes = Object.values(TOOL_PREFIX_BY_PROVIDER);
    for (let i = 0; i < prefixes.length; i++) {
      for (let j = 0; j < prefixes.length; j++) {
        if (i !== j) {
          expect(prefixes[i].startsWith(prefixes[j])).toBe(false);
        }
      }
    }
  });

  it("every provider has a display label", () => {
    const providers = Object.keys(TOOL_PREFIX_BY_PROVIDER) as ProviderId[];
    for (const p of providers) {
      expect(PROVIDER_LABEL[p]).toBeTruthy();
      expect(typeof PROVIDER_LABEL[p]).toBe("string");
    }
  });
});
