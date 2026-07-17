/**
 * Outlook Calendar OAuth Connection provider.
 *
 * Uses the shared microsoft-oauth.ts helper for token exchange/refresh.
 *
 * Verified endpoints (2026-07-17, learn.microsoft.com):
 * - List calendars:   GET /me/calendars
 * - List events:      GET /me/calendarView?startDateTime=&endDateTime= (requires both)
 *                      or GET /me/calendars/{id}/calendarView?startDateTime=&endDateTime=
 * - Create event:     POST /me/events or POST /me/calendars/{id}/events
 *
 * Scopes: offline_access User.Read Calendars.Read Calendars.ReadWrite
 */

import type { ConnectionRow, DispatchResult } from "./types";
import {
  buildMicrosoftAuthorizeUrl,
  callMicrosoftApi,
  exchangeMicrosoftCode,
  expiryFromExpiresIn,
  MICROSOFT_GRAPH_BASE,
} from "./microsoft-oauth";

const OUTLOOK_CAL_SCOPES = "offline_access User.Read Calendars.Read Calendars.ReadWrite";

/** Tool definitions for the Outlook Calendar provider. */
export const OUTCAL_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "outcal_list_calendars",
      description: "List all calendars in the user's Outlook account.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "outcal_list_events",
      description:
        "List events in a time range from the user's Outlook calendar. Returns event subjects, start/end times, and locations.",
      parameters: {
        type: "object",
        properties: {
          time_min: { type: "string", description: "Start time (ISO 8601, e.g. 2026-01-01T00:00:00Z)" },
          time_max: { type: "string", description: "End time (ISO 8601)" },
          calendar_id: { type: "string", description: "Calendar ID (optional; defaults to primary calendar)" },
        },
        required: ["time_min", "time_max"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "outcal_create_event",
      description: "Create a new event in the user's Outlook calendar.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Event title" },
          start: { type: "string", description: "Start time (ISO 8601)" },
          end: { type: "string", description: "End time (ISO 8601)" },
          body: { type: "string", description: "Event body/content (optional)" },
        },
        required: ["subject", "start", "end"],
      },
    },
  },
];

const MAX_RESULT_BYTES = 10_000;

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_BYTES) return text;
  return text.slice(0, MAX_RESULT_BYTES) + "\n…(truncated)";
}

/**
 * Dispatches an Outlook Calendar tool call.
 */
export async function dispatchOutcalTool(
  conn: ConnectionRow,
  toolName: string,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  switch (toolName) {
    case "outcal_list_calendars":
      return outcalListCalendars(conn);
    case "outcal_list_events":
      return outcalListEvents(conn, args);
    case "outcal_create_event":
      return outcalCreateEvent(conn, args);
    default:
      return { content: `Unknown Outlook Calendar tool: ${toolName}` };
  }
}

async function outcalListCalendars(conn: ConnectionRow): Promise<DispatchResult> {
  const result = await callMicrosoftApi(
    conn.accessToken,
    conn.refreshToken,
    "GET",
    `${MICROSOFT_GRAPH_BASE}/me/calendars?$select=id,name,owner`,
  );
  if (!result.ok) return { content: `Outlook Calendar list_calendars failed: ${result.error}` };
  const data = result.data as { value: Array<{ id: string; name: string }> };
  const calendars = data.value ?? [];
  if (calendars.length === 0) return { content: "No calendars found." };
  const lines = ["Calendars:"];
  for (const cal of calendars) {
    lines.push(`- ${cal.name} (id: ${cal.id})`);
  }
  return {
    content: truncate(lines.join("\n")),
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

async function outcalListEvents(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const timeMin = String(args.time_min ?? "");
  const timeMax = String(args.time_max ?? "");
  const calendarId = args.calendar_id ? String(args.calendar_id) : null;
  if (!timeMin || !timeMax) {
    return { content: "outcal_list_events: time_min and time_max are required" };
  }
  // calendarView requires startDateTime + endDateTime
  const basePath = calendarId
    ? `${MICROSOFT_GRAPH_BASE}/me/calendars/${encodeURIComponent(calendarId)}/calendarView`
    : `${MICROSOFT_GRAPH_BASE}/me/calendarView`;
  const url = new URL(basePath);
  url.searchParams.set("startDateTime", timeMin);
  url.searchParams.set("endDateTime", timeMax);
  url.searchParams.set("$select", "id,subject,start,end,location");
  url.searchParams.set("$top", "20");
  const result = await callMicrosoftApi(
    conn.accessToken,
    conn.refreshToken,
    "GET",
    url.toString(),
  );
  if (!result.ok) return { content: `Outlook Calendar list_events failed: ${result.error}` };
  const data = result.data as { value: Array<Record<string, unknown>> };
  const events = data.value ?? [];
  if (events.length === 0) return { content: "No events found in the specified time range." };
  const lines = [`Found ${events.length} events:`];
  for (const event of events) {
    const subject = event.subject as string;
    const start = (event.start as Record<string, string>)?.dateTime ?? "";
    const end = (event.end as Record<string, string>)?.dateTime ?? "";
    const location = (event.location as Record<string, string>)?.displayName;
    lines.push(`- ${subject} | ${start} → ${end}${location ? ` @ ${location}` : ""}`);
  }
  return {
    content: truncate(lines.join("\n")),
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

async function outcalCreateEvent(
  conn: ConnectionRow,
  args: Record<string, unknown>,
): Promise<DispatchResult> {
  const subject = String(args.subject ?? "");
  const start = String(args.start ?? "");
  const end = String(args.end ?? "");
  if (!subject || !start || !end) {
    return { content: "outcal_create_event: subject, start, and end are required" };
  }
  const bodyContent = args.body ? String(args.body) : undefined;
  const result = await callMicrosoftApi(
    conn.accessToken,
    conn.refreshToken,
    "POST",
    `${MICROSOFT_GRAPH_BASE}/me/events`,
    {
      subject,
      start: { dateTime: start, timeZone: "UTC" },
      end: { dateTime: end, timeZone: "UTC" },
      ...(bodyContent ? { body: { contentType: "text", content: bodyContent } } : {}),
    },
  );
  if (!result.ok) return { content: `Outlook Calendar create_event failed: ${result.error}` };
  const data = result.data as { id: string; webLink?: string };
  return {
    content: `Event created: ${subject}\nID: ${data.id}${data.webLink ? `\nLink: ${data.webLink}` : ""}`,
    newAccessToken: result.newAccessToken,
    newRefreshToken: result.newRefreshToken,
    newExpiresAt: result.newExpiresAt,
  };
}

/** Builds the Outlook Calendar OAuth authorize URL. */
export function buildOutlookCalendarAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  return buildMicrosoftAuthorizeUrl(clientId, redirectUri, state, OUTLOOK_CAL_SCOPES);
}

/** Exchanges an authorization code for Outlook Calendar tokens + user profile. */
export async function exchangeOutlookCalendarCode(code: string, redirectUri: string) {
  return exchangeMicrosoftCode(code, redirectUri, OUTLOOK_CAL_SCOPES);
}

export { expiryFromExpiresIn };
