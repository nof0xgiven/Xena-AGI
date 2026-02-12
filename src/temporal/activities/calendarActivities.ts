import { loadWorkerEnv } from "../../env.js";
import {
  createGoogleCalendarClient,
  GoogleCalendarApiError,
  type GoogleCalendarClient,
  type GoogleCalendarEvent,
  type GoogleCalendarEventDateTime,
  type GoogleCalendarEventsDeleteParams,
  type GoogleCalendarEventsGetParams,
  type GoogleCalendarEventsInsertParams,
  type GoogleCalendarEventsListParams,
  type GoogleCalendarEventsListResponse,
  type GoogleCalendarEventsPatchParams,
} from "../../googleCalendar.js";
import { logger } from "../../logger.js";

type CalendarOperation = "list" | "get" | "insert" | "patch" | "delete";

export type CalendarMeetingRequestResult =
  | {
      outcome: "executed";
      operation: CalendarOperation;
      summary: string;
    }
  | {
      outcome: "clarification";
      operation: CalendarOperation;
      clarificationQuestion: string;
    };

const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_OPTIONAL_OFFSET =
  /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)(?:\s*(Z|[+-]\d{2}:\d{2}))?(?:\s+([A-Za-z_]+\/[A-Za-z_]+))?$/;
const TEMPORAL_TOKEN_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?\b/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function compact(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function removeReplyPrefix(subject: string): string {
  return subject.replace(/^(?:re|fw|fwd)\s*:\s*/i, "").trim();
}

function extractLineKeyValue(text: string, keys: readonly string[]): string | null {
  const keySet = new Set(keys.map((key) => key.toLowerCase()));
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9 _-]{2,40})\s*:\s*(.+)$/);
    if (!match) continue;
    const normalizedKey = match[1].toLowerCase().replace(/\s+/g, "_");
    if (!keySet.has(normalizedKey)) continue;
    const value = compact(match[2]);
    if (value) return value;
  }
  return null;
}

function extractEventId(text: string): string | null {
  const labeled = text.match(
    /\b(?:event[\s_-]*id|eventid|id)\s*[:=]\s*([A-Za-z0-9._@-]{5,})\b/i,
  );
  if (labeled?.[1]) return labeled[1].trim();
  return null;
}

function extractTimezone(text: string): string | null {
  const value = extractLineKeyValue(text, ["timezone", "time_zone", "tz"]);
  return value ? value : null;
}

function extractTitle(subject: string, text: string): string | null {
  const labeled = extractLineKeyValue(text, ["title", "summary", "meeting_title", "subject"]);
  if (labeled) return labeled;
  const cleaned = removeReplyPrefix(compact(subject));
  return cleaned.length > 0 ? cleaned : null;
}

function extractDescription(text: string): string | null {
  const labeled = extractLineKeyValue(text, ["description", "notes", "objective", "agenda"]);
  return labeled ? labeled : null;
}

function extractLocation(text: string): string | null {
  const labeled = extractLineKeyValue(text, ["location", "where"]);
  return labeled ? labeled : null;
}

function extractAttendees(text: string): string[] {
  const inline = Array.from(new Set((text.match(EMAIL_RE) ?? []).map((email) => email.toLowerCase())));
  if (inline.length > 0) return inline;
  const labeled = extractLineKeyValue(text, ["attendees", "invitees", "participants"]);
  if (!labeled) return [];
  return Array.from(new Set((labeled.match(EMAIL_RE) ?? []).map((email) => email.toLowerCase())));
}

function parseEventDateTime(rawValue: string, defaultTimezone: string): GoogleCalendarEventDateTime | null {
  const value = compact(rawValue);
  if (!value) return null;
  if (ISO_DATE.test(value)) {
    return { date: value };
  }
  const match = value.match(ISO_DATETIME_OPTIONAL_OFFSET);
  if (!match) return null;
  const dateTime = match[1].replace(" ", "T");
  const offset = match[2];
  const explicitTimezone = match[3];
  if (offset) {
    return { dateTime: `${dateTime}${offset}` };
  }
  return {
    dateTime,
    timeZone: explicitTimezone ?? defaultTimezone,
  };
}

function extractTimeValue(text: string, keys: readonly string[]): string | null {
  const labeled = extractLineKeyValue(text, keys);
  if (labeled) return labeled;
  return null;
}

function extractTimeBounds(text: string): { start: string | null; end: string | null } {
  const start = extractTimeValue(text, [
    "start",
    "start_time",
    "starts_at",
    "from",
    "time_min",
    "timemin",
  ]);
  const end = extractTimeValue(text, [
    "end",
    "end_time",
    "ends_at",
    "until",
    "to",
    "time_max",
    "timemax",
  ]);
  if (start || end) return { start, end };

  const tokens = text.match(TEMPORAL_TOKEN_RE) ?? [];
  if (tokens.length >= 2) {
    const [startToken, endToken] = tokens as [string, string, ...string[]];
    return { start: startToken, end: endToken };
  }
  return { start: null, end: null };
}

function extractCalendarId(text: string, fallbackCalendarId: string): string {
  const labeled = extractLineKeyValue(text, ["calendar_id", "calendar"]);
  return labeled ? labeled : fallbackCalendarId;
}

function chooseOperation(subject: string, body: string): CalendarOperation {
  const source = `${subject}\n${body}`.toLowerCase();

  const deletePatterns = [/\bcancel\b/, /\bdelete\b/, /\bremove\b/, /\bdrop\b/];
  if (deletePatterns.some((pattern) => pattern.test(source))) return "delete";

  const patchPatterns = [/\breschedule\b/, /\bmove\b/, /\bupdate\b/, /\bchange\b/, /\bedit\b/];
  if (patchPatterns.some((pattern) => pattern.test(source))) return "patch";

  const insertPatterns = [/\bschedule\b/, /\bbook\b/, /\bset up\b/, /\barrange\b/, /\bcreate\b/];
  if (insertPatterns.some((pattern) => pattern.test(source)) && /\b(meeting|call|sync|appointment)\b/.test(source)) {
    return "insert";
  }

  const getPatterns = [/\bdetails\b/, /\bshow\b/, /\bget\b/, /\blookup\b/, /\bfind\b/];
  if (getPatterns.some((pattern) => pattern.test(source)) && /\bevent\b/.test(source)) return "get";

  const listPatterns = [/\blist\b/, /\bagenda\b/, /\bupcoming\b/, /\bwhat(?:'s| is)\b/, /\bcalendar\b/];
  if (listPatterns.some((pattern) => pattern.test(source))) return "list";

  return "insert";
}

function eventTimeLabel(value: GoogleCalendarEventDateTime | undefined): string {
  if (!value) return "unspecified";
  if (value.dateTime) return value.timeZone ? `${value.dateTime} ${value.timeZone}` : value.dateTime;
  if (value.date) return value.date;
  return "unspecified";
}

function summarizeEvent(event: GoogleCalendarEvent): string {
  const summary = compact(event.summary) || "(untitled event)";
  const id = compact(event.id) || "unknown-id";
  return `${summary} [${id}] ${eventTimeLabel(event.start)} -> ${eventTimeLabel(event.end)}`;
}

function toListWindowValue(raw: string): string | null {
  const normalized = compact(raw).replace(" ", "T");
  if (RFC3339_WITH_OFFSET.test(normalized)) return normalized;
  if (ISO_DATE.test(normalized)) return `${normalized}T00:00:00Z`;
  return null;
}

function clarification(operation: CalendarOperation, question: string): CalendarMeetingRequestResult {
  const normalizedQuestion = compact(question).replace(/[.?\s]+$/, "");
  return {
    outcome: "clarification",
    operation,
    clarificationQuestion: `${normalizedQuestion}?`,
  };
}

function googleCalendarClient(): GoogleCalendarClient {
  const env = loadWorkerEnv();
  const clientId = env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret = env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_CALENDAR_REFRESH_TOKEN;

  const missing: string[] = [];
  if (!clientId) missing.push("GOOGLE_CALENDAR_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_CALENDAR_CLIENT_SECRET");
  if (!refreshToken) missing.push("GOOGLE_CALENDAR_REFRESH_TOKEN");
  if (missing.length > 0) {
    throw new Error(`google_calendar_not_configured: missing ${missing.join(", ")}`);
  }
  const ensuredClientId = clientId as string;
  const ensuredClientSecret = clientSecret as string;
  const ensuredRefreshToken = refreshToken as string;

  return createGoogleCalendarClient({
    clientId: ensuredClientId,
    clientSecret: ensuredClientSecret,
    refreshToken: ensuredRefreshToken,
    defaultCalendarId: env.GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID ?? "primary",
    defaultTimeZone: env.GOOGLE_CALENDAR_DEFAULT_TIMEZONE ?? "UTC",
    scopes: splitCsv(env.GOOGLE_CALENDAR_SCOPES),
    oauthTokenUrl: env.GOOGLE_CALENDAR_TOKEN_URL,
    baseUrl: env.GOOGLE_CALENDAR_BASE_URL,
  });
}

export async function calendarEventsList(
  opts: GoogleCalendarEventsListParams = {},
): Promise<GoogleCalendarEventsListResponse> {
  const client = googleCalendarClient();
  return client.events.list(opts);
}

export async function calendarEventsGet(opts: GoogleCalendarEventsGetParams): Promise<GoogleCalendarEvent> {
  const client = googleCalendarClient();
  return client.events.get(opts);
}

export async function calendarEventsInsert(opts: GoogleCalendarEventsInsertParams): Promise<GoogleCalendarEvent> {
  const client = googleCalendarClient();
  return client.events.insert(opts);
}

export async function calendarEventsPatch(opts: GoogleCalendarEventsPatchParams): Promise<GoogleCalendarEvent> {
  const client = googleCalendarClient();
  return client.events.patch(opts);
}

export async function calendarEventsDelete(
  opts: GoogleCalendarEventsDeleteParams,
): Promise<{ deleted: true; eventId: string; calendarId: string }> {
  const client = googleCalendarClient();
  return client.events.delete(opts);
}

function buildListSummary(listed: GoogleCalendarEventsListResponse, calendarId: string): string {
  const count = listed.items.length;
  if (count === 0) return `Checked calendar ${calendarId}; no matching events were found.`;
  const preview = listed.items.slice(0, 3).map((item) => `- ${summarizeEvent(item)}`);
  const more = count > 3 ? `\n- ...and ${count - 3} more` : "";
  return `Listed ${count} event(s) on calendar ${calendarId}.\n${preview.join("\n")}${more}`;
}

function buildInsertEventPayload(args: {
  subject: string;
  text: string;
  defaultTimezone: string;
  fromEmail?: string;
}): { event: GoogleCalendarEvent; missingQuestion?: string } {
  const title = extractTitle(args.subject, args.text);
  const description = extractDescription(args.text);
  const location = extractLocation(args.text);
  const attendees = extractAttendees(args.text);
  if (args.fromEmail && args.fromEmail.includes("@")) {
    attendees.push(args.fromEmail.toLowerCase());
  }
  const uniqueAttendees = Array.from(new Set(attendees));
  const { start, end } = extractTimeBounds(args.text);

  if (!start || !end) {
    return {
      event: {},
      missingQuestion:
        "Please provide both start and end times in ISO format, for example start: 2026-03-14T09:00:00-07:00 and end: 2026-03-14T09:30:00-07:00.",
    };
  }

  const parsedStart = parseEventDateTime(start, args.defaultTimezone);
  const parsedEnd = parseEventDateTime(end, args.defaultTimezone);
  if (!parsedStart || !parsedEnd) {
    return {
      event: {},
      missingQuestion:
        "Please provide valid start and end times using YYYY-MM-DD or YYYY-MM-DDTHH:mm with timezone offset.",
    };
  }

  return {
    event: {
      summary: title ?? "Meeting",
      description: description ?? undefined,
      location: location ?? undefined,
      start: parsedStart,
      end: parsedEnd,
      attendees:
        uniqueAttendees.length > 0
          ? uniqueAttendees.map((email) => ({
              email,
            }))
          : undefined,
    },
  };
}

function mapCalendarErrorToQuestion(err: unknown, operation: CalendarOperation): string {
  const genericMessage = err instanceof Error ? err.message : String(err);
  if (genericMessage.includes("google_calendar_not_configured")) {
    return "Google Calendar is not configured yet. Please set GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET, and GOOGLE_CALENDAR_REFRESH_TOKEN.";
  }
  if (!(err instanceof GoogleCalendarApiError)) {
    return "Can you confirm the exact calendar details you want me to apply so I can try again?";
  }
  if (err.code === "bad_request") {
    return "Can you provide the missing or corrected calendar fields in explicit key:value form so I can execute this request?";
  }
  if (err.code === "not_found") {
    return "I could not find that event. Can you confirm the event_id value?";
  }
  if (err.code === "conflict") {
    return "This event changed concurrently. Should I retry the same operation with the latest event version?";
  }
  if (err.code === "unauthorized" || err.code === "forbidden") {
    return "Calendar access was denied. Can you confirm the OAuth credentials and calendar permissions are valid for this operation?";
  }
  if (err.code === "gone") {
    return "That event is no longer available. Do you want me to create a new meeting entry instead?";
  }
  if (err.code === "rate_limited") {
    return "Google Calendar is rate limiting requests right now. Should I retry this operation shortly?";
  }
  return `Can you confirm I should retry this ${operation} request with the same parameters?`;
}

export async function calendarHandleMeetingRequest(opts: {
  subject?: string;
  body?: string;
  fromEmail?: string;
  calendarId?: string;
  timezone?: string;
}): Promise<CalendarMeetingRequestResult> {
  const subject = compact(opts.subject);
  const body = compact(opts.body);
  const text = [subject, body].filter(Boolean).join("\n");
  const operation = chooseOperation(subject, body);
  let calendarId = extractCalendarId(text, compact(opts.calendarId) || "primary");
  let timezone = (extractTimezone(text) ?? compact(opts.timezone)) || "UTC";

  try {
    const client = googleCalendarClient();
    calendarId = extractCalendarId(text, opts.calendarId ?? client.defaultCalendarId);
    timezone = (extractTimezone(text) ?? compact(opts.timezone)) || client.defaultTimeZone;

    if (operation === "list") {
      const { start, end } = extractTimeBounds(text);
      if ((start && !end) || (!start && end)) {
        return clarification(
          operation,
          "Please provide both time_min and time_max in RFC3339 format so I can list the correct calendar window.",
        );
      }
      const now = new Date();
      const defaultStart = now.toISOString();
      const defaultEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const timeMin = start ? toListWindowValue(start) : defaultStart;
      const timeMax = end ? toListWindowValue(end) : defaultEnd;
      if ((start && !timeMin) || (end && !timeMax)) {
        return clarification(
          operation,
          "Please provide time_min and time_max as RFC3339 values with timezone, for example 2026-03-14T09:00:00-07:00.",
        );
      }
      const listed = await client.events.list({
        calendarId,
        timeMin: timeMin ?? undefined,
        timeMax: timeMax ?? undefined,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 20,
        timeZone: timezone,
      });
      return {
        outcome: "executed",
        operation,
        summary: buildListSummary(listed, calendarId),
      };
    }

    if (operation === "get") {
      const eventId = extractEventId(text);
      if (!eventId) return clarification(operation, "Please provide event_id so I can fetch the exact meeting.");
      const event = await client.events.get({
        calendarId,
        eventId,
        timeZone: timezone,
      });
      return {
        outcome: "executed",
        operation,
        summary: `Fetched event details: ${summarizeEvent(event)}.`,
      };
    }

    if (operation === "delete") {
      const eventId = extractEventId(text);
      if (!eventId) return clarification(operation, "Please provide event_id so I can cancel the correct meeting.");
      await client.events.delete({
        calendarId,
        eventId,
        sendUpdates: "all",
      });
      return {
        outcome: "executed",
        operation,
        summary: `Canceled event ${eventId} from calendar ${calendarId}.`,
      };
    }

    if (operation === "patch") {
      const eventId = extractEventId(text);
      if (!eventId) return clarification(operation, "Please provide event_id so I can update the correct meeting.");

      const title = extractTitle(subject, text);
      const description = extractDescription(text);
      const location = extractLocation(text);
      const attendees = extractAttendees(text);
      const { start, end } = extractTimeBounds(text);

      const patch: GoogleCalendarEvent = {};
      if (title) patch.summary = title;
      if (description) patch.description = description;
      if (location) patch.location = location;
      if (attendees.length > 0) {
        patch.attendees = attendees.map((email) => ({ email }));
      }
      if (start && end) {
        const parsedStart = parseEventDateTime(start, timezone);
        const parsedEnd = parseEventDateTime(end, timezone);
        if (!parsedStart || !parsedEnd) {
          return clarification(
            operation,
            "Please provide valid start/end values using YYYY-MM-DD or YYYY-MM-DDTHH:mm with timezone offset.",
          );
        }
        patch.start = parsedStart;
        patch.end = parsedEnd;
      } else if (start || end) {
        return clarification(operation, "Please provide both start and end values when rescheduling a meeting.");
      }

      if (Object.keys(patch).length === 0) {
        return clarification(
          operation,
          "Please specify at least one field to update (summary, start/end, location, attendees, or description).",
        );
      }

      const updated = await client.events.patch({
        calendarId,
        eventId,
        event: patch,
        sendUpdates: "all",
      });

      return {
        outcome: "executed",
        operation,
        summary: `Updated event ${eventId}: ${summarizeEvent(updated)}.`,
      };
    }

    const insertPayload = buildInsertEventPayload({
      subject,
      text,
      defaultTimezone: timezone,
      fromEmail: opts.fromEmail,
    });
    if (insertPayload.missingQuestion) {
      return clarification(operation, insertPayload.missingQuestion);
    }

    const created = await client.events.insert({
      calendarId,
      event: insertPayload.event,
      sendUpdates: "all",
    });

    return {
      outcome: "executed",
      operation,
      summary: `Created event: ${summarizeEvent(created)}.`,
    };
  } catch (err) {
    logger.warn(
      {
        err,
        operation,
        calendarId,
        subject,
      },
      "calendarHandleMeetingRequest failed",
    );
    return clarification(operation, mapCalendarErrorToQuestion(err, operation));
  }
}
