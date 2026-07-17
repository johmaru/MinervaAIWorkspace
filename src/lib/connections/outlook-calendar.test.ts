// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchOutcalTool, OUTCAL_TOOLS } from "./outlook-calendar";
import type { ConnectionRow } from "./types";

function mockConn(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "conn-1",
    provider: "outlook_calendar",
    accessToken: "eyJ.test",
    refreshToken: "M.R3 refresh",
    scopes: "offline_access User.Read Calendars.Read Calendars.ReadWrite",
    expiresAt: null,
    workspaceName: "Outlook Calendar",
    ...overrides,
  };
}

describe("OUTCAL_TOOLS", () => {
  it("has 3 tools with outcal_ prefix", () => {
    expect(OUTCAL_TOOLS).toHaveLength(3);
    for (const tool of OUTCAL_TOOLS) {
      expect(tool.function.name.startsWith("outcal_")).toBe(true);
    }
  });
});

describe("dispatchOutcalTool", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns error for unknown tool", async () => {
    const result = await dispatchOutcalTool(mockConn(), "outcal_unknown", {});
    expect(result.content).toContain("Unknown Outlook Calendar tool");
  });

  it("outcal_list_calendars formats calendar list", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          value: [
            { id: "cal1", name: "My Calendar" },
            { id: "cal2", name: "Work" },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchOutcalTool(mockConn(), "outcal_list_calendars", {});
    expect(result.content).toContain("My Calendar");
    expect(result.content).toContain("Work");
  });

  it("outcal_list_events formats event list", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          value: [
            {
              subject: "Team meeting",
              start: { dateTime: "2026-01-15T10:00:00Z" },
              end: { dateTime: "2026-01-15T11:00:00Z" },
              location: { displayName: "Conference Room" },
            },
            {
              subject: "Lunch",
              start: { dateTime: "2026-01-15T12:00:00Z" },
              end: { dateTime: "2026-01-15T13:00:00Z" },
              location: { displayName: null },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchOutcalTool(mockConn(), "outcal_list_events", {
      time_min: "2026-01-15T00:00:00Z",
      time_max: "2026-01-16T00:00:00Z",
    });
    expect(result.content).toContain("Found 2 events");
    expect(result.content).toContain("Team meeting");
    expect(result.content).toContain("@ Conference Room");
    expect(result.content).toContain("Lunch");
  });

  it("outcal_create_event returns event ID", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "evt123",
          webLink: "https://outlook.live.com/owa/?itemid=evt123",
        }),
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchOutcalTool(mockConn(), "outcal_create_event", {
      subject: "New meeting",
      start: "2026-01-20T14:00:00Z",
      end: "2026-01-20T15:00:00Z",
    });
    expect(result.content).toContain("Event created: New meeting");
    expect(result.content).toContain("evt123");
  });
});
