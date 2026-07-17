// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchGcalTool, GCAL_TOOLS } from "./google-calendar";
import type { ConnectionRow } from "./types";

function mockConn(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "conn-1",
    provider: "google_calendar",
    accessToken: "ya29.test",
    refreshToken: "1//refresh",
    scopes: "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events",
    expiresAt: null,
    workspaceName: "Google Calendar",
    ...overrides,
  };
}

describe("GCAL_TOOLS", () => {
  it("has 3 tools with gcal_ prefix", () => {
    expect(GCAL_TOOLS).toHaveLength(3);
    for (const tool of GCAL_TOOLS) {
      expect(tool.function.name.startsWith("gcal_")).toBe(true);
    }
  });
});

describe("dispatchGcalTool", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns error for unknown tool", async () => {
    const result = await dispatchGcalTool(mockConn(), "gcal_unknown", {});
    expect(result.content).toContain("Unknown Google Calendar tool");
  });

  it("gcal_list_calendars formats calendar list", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            { id: "primary", summary: "My Calendar", primary: true },
            { id: "cal2@group.calendar.google.com", summary: "Work" },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGcalTool(mockConn(), "gcal_list_calendars", {});
    expect(result.content).toContain("My Calendar");
    expect(result.content).toContain("[primary]");
    expect(result.content).toContain("Work");
  });

  it("gcal_list_events formats event list", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              summary: "Team meeting",
              start: { dateTime: "2026-01-15T10:00:00Z" },
              end: { dateTime: "2026-01-15T11:00:00Z" },
              location: "Zoom",
            },
            {
              summary: "Lunch",
              start: { dateTime: "2026-01-15T12:00:00Z" },
              end: { dateTime: "2026-01-15T13:00:00Z" },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGcalTool(mockConn(), "gcal_list_events", {
      calendar_id: "primary",
      time_min: "2026-01-15T00:00:00Z",
      time_max: "2026-01-16T00:00:00Z",
    });
    expect(result.content).toContain("Found 2 events");
    expect(result.content).toContain("Team meeting");
    expect(result.content).toContain("@ Zoom");
    expect(result.content).toContain("Lunch");
  });

  it("gcal_create_event returns event link", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "evt123",
          htmlLink: "https://www.google.com/calendar/event?eid=evt123",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchGcalTool(mockConn(), "gcal_create_event", {
      calendar_id: "primary",
      summary: "New meeting",
      start: "2026-01-20T14:00:00Z",
      end: "2026-01-20T15:00:00Z",
    });
    expect(result.content).toContain("Event created: New meeting");
    expect(result.content).toContain("evt123");
  });
});
