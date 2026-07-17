/**
 * Google Calendar OAuth Connection provider.
 *
 * Uses the shared google-oauth.ts helper for token exchange/refresh.
 *
 * Verified endpoints (2026-07-17, developers.google.com):
 * - calendarList.list: GET https://www.googleapis.com/calendar/v3/users/me/calendarList
 * - events.list:       GET https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events?timeMin=&timeMax=&singleEvents=true&orderBy=startTime
 * - events.insert:     POST https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events?sendUpdates=none
 *
 * Scopes: calendar.readonly + calendar.events (read + create events)
 */

import type { ConnectionRow, DispatchResult } from "./types";
import {
  buildGoogleAuthorizeUrl,
  callGoogleApi,
  exchangeGoogleCode,
  expiryFromExpiresIn,
} from "./google-oauth";

const CALENDAR_SCOPES =
  "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events";
const API_BASE = "https://www.googleapis.com/calendar/v3";
const MAX_RESULT_BYTES = 10_000;

export const GOOGLE_CALENDAR_SCOPES = CALENDAR_SCOPES;

/** Tool definitions for the Google Calendar provider. */
export const GCAL_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "gcal_list_calendars",
      description: "List all calendars in the user's Google Calendar account.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gcal_list_events",
      description:
        "List events in a time range from a Google Calendar. Returns event summaries, start/end times, and locations.",
      parameters: {
        type: "object",
        properties: {
          calendar_id: {
            type: "string",
            description: "Calendar ID (use 'primary' for the user's main calendar)",
          },
          time_min: { type: "string", description: "Start time (RFC3339, e.g. 2026-01-01T00:00:00Z)" },
          time_max: { type: "string", description: "End time (RFC3339)" },
        },
        required: ["calendar_id", "time_min", "time_max"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gcal_create_event",
      description: "Create a new event in a Google Calendar.",
      parameters: {
        type: "object",
        properties: {
          calendar_id: {
            type: "string",
            description: "Calendar ID (use 'primary' for the user's main calendar)",
          },
          summary: { type: "string", description: "Event title" },
          start: { type: "string", description: "Start time (RFC3339)" },
          end: { type: "string", description: "End time (RFC3339)" },
          description: { type: "string", description: "Event description (optional)" },
        },
        required: ["calendar_id", "summary", "start", "end"],
      },
    },
  },
];

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_BYTES) return text;
  return text.slice(0, MAX_RESULT_BYTES) + "\n…(truncated)";
}

/**
 * Dispatches a Google Calendar tool call.
 */
export async function dispatchGcalTool(
  conn: ConnectionRow,
  toolName: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  switch (toolName) {
    case "gcal_list_calendars":
      return gcalListCalendars(conn);
    case "gcal_list_events":
      return gcalListEvents(conn, args);
    case "gcal_create_event":
      return gcalCreateEvent(conn, args);
    default:
      return { content: `Unknown Google Calendar tool: ${toolName}` };
  }
}

async function gcalListCalendars(conn: ConnectionRow): Promise<DispatchResult> {
  const result = await callGoogleApi(
    conn.accessToken,
    conn.refreshToken,
    "GET",
    `${API_BASE}/users/me/calendarList`,
  );
  if (!result.ok) return { content: `Google Calendar list_calendars failed: ${result.error}` };
  const data = result.data as { items: Array<Record<string, unknown>> };
  const calendars = data.items ?? [];
  if (calendars.length === 0) return { content: "No calendars found." };
  const lines = ["Calendars:"];
  for (const cal of calendars) {
    const id = cal.id as string;
    const summary = cal.summary as string;
    const primary = cal.primary as boolean | undefined;
    lines.push(`- ${summary} (id: ${id})${primary ? " [primary]" : ""}`);
  }
  return {
    content: truncate(lines.join("\n")),
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

async function gcalListEvents(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const calendarId = String(args.calendar_id ?? "");
  const timeMin = String(args.time_min ?? "");
  const timeMax = String(args.time_max ?? "");
  if (!calendarId || !timeMin || !timeMax) {
    return { content: "gcal_list_events: calendar_id, time_min, and time_max are required" };
  }
  const url = new URL(`${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "20");
  const result = await callGoogleApi(
    conn.accessToken,
    conn.refreshToken,
    "GET",
    url.toString(),
  );
  if (!result.ok) return { content: `Google Calendar list_events failed: ${result.error}` };
  const data = result.data as { items: Array<Record<string, unknown>> };
  const events = data.items ?? [];
  if (events.length === 0) return { content: "No events found in the specified time range." };
  const lines = [`Found ${events.length} events:`];
  for (const event of events) {
    const summary = event.summary as string;
    const start = (event.start as Record<string, string>)?.dateTime ?? (event.start as Record<string, string>)?.date ?? "";
    const end = (event.end as Record<string, string>)?.dateTime ?? (event.end as Record<string, string>)?.date ?? "";
    const location = event.location as string | undefined;
    lines.push(`- ${summary} | ${start} → ${end}${location ? ` @ ${location}` : ""}`);
  }
  return {
    content: truncate(lines.join("\n")),
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

async function gcalCreateEvent(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const calendarId = String(args.calendar_id ?? "");
  const summary = String(args.summary ?? "");
  const start = String(args.start ?? "");
  const end = String(args.end ?? "");
  if (!calendarId || !summary || !start || !end) {
    return { content: "gcal_create_event: calendar_id, summary, start, and end are required" };
  }
  const description = args.description ? String(args.description) : undefined;
  const url = new URL(`${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("sendUpdates", "none");
  const result = await callGoogleApi(
    conn.accessToken,
    conn.refreshToken,
    "POST",
    url.toString(),
    {
      summary,
      start: { dateTime: start },
      end: { dateTime: end },
      ...(description ? { description } : {}),
    },
  );
  if (!result.ok) return { content: `Google Calendar create_event failed: ${result.error}` };
  const data = result.data as { id: string; htmlLink: string };
  return {
    content: `Event created: ${summary}\nID: ${data.id}\nLink: ${data.htmlLink ?? "(none)"}`,
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

/** Builds the Google Calendar OAuth authorize URL. */
export function buildGoogleCalendarAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  return buildGoogleAuthorizeUrl(clientId, redirectUri, state, CALENDAR_SCOPES);
}

/** Exchanges an authorization code for Google Calendar tokens + user profile. */
export async function exchangeGoogleCalendarCode(code: string, redirectUri: string) {
  return exchangeGoogleCode(code, redirectUri, CALENDAR_SCOPES);
}

export { expiryFromExpiresIn };
