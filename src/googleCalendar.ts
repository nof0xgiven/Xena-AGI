const DEFAULT_GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const DEFAULT_GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_GOOGLE_CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";

const OAUTH_REFRESH_MAX_ATTEMPTS = 4;
const CALENDAR_REQUEST_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 20_000;
const REQUEST_TIMEOUT_MS = 45_000;
const ACCESS_TOKEN_EXPIRY_SKEW_MS = 60_000;

type GoogleCalendarHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type GoogleCalendarEventDateTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

export type GoogleCalendarEventAttendee = {
  email: string;
  displayName?: string;
  optional?: boolean;
  responseStatus?: string;
};

export type GoogleCalendarEvent = {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: GoogleCalendarEventDateTime;
  end?: GoogleCalendarEventDateTime;
  attendees?: GoogleCalendarEventAttendee[];
  [key: string]: unknown;
};

export type GoogleCalendarEventsListResponse = {
  kind?: string;
  etag?: string;
  summary?: string;
  description?: string;
  updated?: string;
  timeZone?: string;
  nextPageToken?: string;
  nextSyncToken?: string;
  items: GoogleCalendarEvent[];
  [key: string]: unknown;
};

export type GoogleCalendarEventsListParams = {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  pageToken?: string;
  q?: string;
  orderBy?: "startTime" | "updated";
  singleEvents?: boolean;
  showDeleted?: boolean;
  timeZone?: string;
};

export type GoogleCalendarEventsGetParams = {
  calendarId?: string;
  eventId: string;
  timeZone?: string;
};

export type GoogleCalendarEventsInsertParams = {
  calendarId?: string;
  event: GoogleCalendarEvent;
  sendUpdates?: "all" | "externalOnly" | "none";
  conferenceDataVersion?: number;
};

export type GoogleCalendarEventsPatchParams = {
  calendarId?: string;
  eventId: string;
  event: GoogleCalendarEvent;
  sendUpdates?: "all" | "externalOnly" | "none";
  conferenceDataVersion?: number;
};

export type GoogleCalendarEventsDeleteParams = {
  calendarId?: string;
  eventId: string;
  sendUpdates?: "all" | "externalOnly" | "none";
};

export type GoogleCalendarClientOptions = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  defaultCalendarId: string;
  defaultTimeZone: string;
  scopes?: string[];
  oauthTokenUrl?: string;
  baseUrl?: string;
};

export type GoogleCalendarErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "gone"
  | "rate_limited"
  | "server_error"
  | "oauth_error"
  | "unknown";

export class GoogleCalendarApiError extends Error {
  readonly status: number;
  readonly code: GoogleCalendarErrorCode;
  readonly retryable: boolean;
  readonly reason?: string;
  readonly details?: unknown;

  constructor(opts: {
    message: string;
    status: number;
    code: GoogleCalendarErrorCode;
    retryable: boolean;
    reason?: string;
    details?: unknown;
  }) {
    super(opts.message);
    this.name = "GoogleCalendarApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.retryable = opts.retryable;
    this.reason = opts.reason;
    this.details = opts.details;
  }
}

export type GoogleCalendarClient = {
  readonly defaultCalendarId: string;
  readonly defaultTimeZone: string;
  events: {
    list: (params?: GoogleCalendarEventsListParams) => Promise<GoogleCalendarEventsListResponse>;
    get: (params: GoogleCalendarEventsGetParams) => Promise<GoogleCalendarEvent>;
    insert: (params: GoogleCalendarEventsInsertParams) => Promise<GoogleCalendarEvent>;
    patch: (params: GoogleCalendarEventsPatchParams) => Promise<GoogleCalendarEvent>;
    delete: (params: GoogleCalendarEventsDeleteParams) => Promise<{ deleted: true; eventId: string; calendarId: string }>;
  };
};

type ErrorClassification = {
  code: GoogleCalendarErrorCode;
  retryable: boolean;
  message: string;
};

type ParsedGoogleErrorPayload = {
  message?: string;
  reason?: string;
};

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeScopes(input: string[] | undefined): string[] {
  const cleaned = (input ?? [])
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
  return cleaned.length > 0 ? cleaned : [DEFAULT_GOOGLE_CALENDAR_SCOPE];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const numeric = Number(headerValue);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric * 1000);
  const asDate = Date.parse(headerValue);
  if (Number.isNaN(asDate)) return undefined;
  const delta = asDate - Date.now();
  return delta > 0 ? delta : 0;
}

function computeBackoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) {
    return Math.min(Math.max(retryAfterMs, 0), BACKOFF_MAX_MS);
  }
  const exponential = BACKOFF_BASE_MS * 2 ** Math.max(0, attempt);
  return Math.min(exponential, BACKOFF_MAX_MS);
}

async function readResponseBody(res: Response): Promise<{ rawText: string; parsed: unknown }> {
  const rawText = await res.text();
  if (!rawText) return { rawText: "", parsed: null };
  try {
    return { rawText, parsed: JSON.parse(rawText) };
  } catch {
    return { rawText, parsed: rawText };
  }
}

function parseGoogleErrorPayload(payload: unknown): ParsedGoogleErrorPayload {
  if (!payload || typeof payload !== "object") return {};
  const root = payload as Record<string, unknown>;
  const errorRoot =
    root.error && typeof root.error === "object"
      ? (root.error as Record<string, unknown>)
      : root;
  const message = typeof errorRoot.message === "string" ? errorRoot.message : undefined;
  let reason: string | undefined;
  const errors = Array.isArray(errorRoot.errors) ? errorRoot.errors : [];
  if (errors.length > 0) {
    const first = errors[0];
    if (first && typeof first === "object" && typeof (first as Record<string, unknown>).reason === "string") {
      reason = (first as Record<string, unknown>).reason as string;
    }
  }
  return { message, reason };
}

function classifyStatus(status: number, payload: unknown): ErrorClassification {
  const parsed = parseGoogleErrorPayload(payload);
  const reason = (parsed.reason ?? "").toLowerCase();

  if (status === 400) {
    return {
      code: "bad_request",
      retryable: false,
      message: parsed.message ?? "Google Calendar rejected the request payload (400).",
    };
  }
  if (status === 401) {
    return {
      code: "unauthorized",
      retryable: false,
      message: parsed.message ?? "Google Calendar credentials were rejected (401).",
    };
  }
  if (status === 403) {
    const isRateLimitedReason =
      reason.includes("ratelimit") || reason.includes("rate_limit") || reason.includes("quota");
    return {
      code: isRateLimitedReason ? "rate_limited" : "forbidden",
      retryable: isRateLimitedReason,
      message:
        parsed.message ??
        (isRateLimitedReason
          ? "Google Calendar rate/quota limit reached (403)."
          : "Google Calendar request is forbidden (403)."),
    };
  }
  if (status === 404) {
    return {
      code: "not_found",
      retryable: false,
      message: parsed.message ?? "Google Calendar resource was not found (404).",
    };
  }
  if (status === 409) {
    return {
      code: "conflict",
      retryable: true,
      message: parsed.message ?? "Google Calendar returned a conflict (409).",
    };
  }
  if (status === 410) {
    return {
      code: "gone",
      retryable: false,
      message: parsed.message ?? "Google Calendar resource is gone (410).",
    };
  }
  if (status === 429) {
    return {
      code: "rate_limited",
      retryable: true,
      message: parsed.message ?? "Google Calendar rate limited this request (429).",
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      code: "server_error",
      retryable: true,
      message: parsed.message ?? `Google Calendar server error (${status}).`,
    };
  }
  return {
    code: "unknown",
    retryable: false,
    message: parsed.message ?? `Google Calendar request failed (${status}).`,
  };
}

class GoogleCalendarRuntime {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly defaultCalendarId: string;
  private readonly defaultTimeZone: string;
  private readonly scopes: string[];
  private readonly oauthTokenUrl: string;
  private readonly baseUrl: string;

  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(opts: GoogleCalendarClientOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.refreshToken = opts.refreshToken;
    this.defaultCalendarId = opts.defaultCalendarId;
    this.defaultTimeZone = opts.defaultTimeZone;
    this.scopes = normalizeScopes(opts.scopes);
    this.oauthTokenUrl = trimTrailingSlashes(opts.oauthTokenUrl ?? DEFAULT_GOOGLE_OAUTH_TOKEN_URL);
    this.baseUrl = trimTrailingSlashes(opts.baseUrl ?? DEFAULT_GOOGLE_CALENDAR_BASE_URL);
  }

  toClient(): GoogleCalendarClient {
    return {
      defaultCalendarId: this.defaultCalendarId,
      defaultTimeZone: this.defaultTimeZone,
      events: {
        list: (params) => this.eventsList(params),
        get: (params) => this.eventsGet(params),
        insert: (params) => this.eventsInsert(params),
        patch: (params) => this.eventsPatch(params),
        delete: (params) => this.eventsDelete(params),
      },
    };
  }

  private resolveCalendarId(input?: string): string {
    const candidate = (input ?? "").trim();
    return candidate.length > 0 ? candidate : this.defaultCalendarId;
  }

  private async getAccessToken(forceRefresh: boolean): Promise<string> {
    const now = Date.now();
    if (!forceRefresh && this.accessToken && now < this.accessTokenExpiresAt - ACCESS_TOKEN_EXPIRY_SKEW_MS) {
      return this.accessToken;
    }
    await this.refreshAccessTokenWithRetry();
    if (!this.accessToken) {
      throw new Error("Google OAuth refresh succeeded but access token is missing.");
    }
    return this.accessToken;
  }

  private async refreshAccessTokenWithRetry(): Promise<void> {
    for (let attempt = 0; attempt < OAUTH_REFRESH_MAX_ATTEMPTS; attempt += 1) {
      const res = await fetch(this.oauthTokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: this.refreshToken,
          grant_type: "refresh_token",
          scope: this.scopes.join(" "),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const { parsed } = await readResponseBody(res);
      if (res.ok) {
        const tokenPayload =
          parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : ({} as Record<string, unknown>);
        const accessToken = typeof tokenPayload.access_token === "string" ? tokenPayload.access_token : null;
        if (!accessToken) {
          throw new Error("Google OAuth token response did not include access_token.");
        }
        const expiresInRaw = tokenPayload.expires_in;
        const expiresInSeconds =
          typeof expiresInRaw === "number" && Number.isFinite(expiresInRaw) ? expiresInRaw : 3600;
        this.accessToken = accessToken;
        this.accessTokenExpiresAt = Date.now() + Math.max(60, expiresInSeconds) * 1000;
        return;
      }

      const classification = classifyStatus(res.status, parsed);
      const retryAfterMs = resolveRetryAfterMs(res.headers.get("retry-after"));
      const canRetry = classification.retryable && attempt < OAUTH_REFRESH_MAX_ATTEMPTS - 1;
      if (canRetry) {
        await sleep(computeBackoffMs(attempt, retryAfterMs));
        continue;
      }

      throw new GoogleCalendarApiError({
        message: `Google OAuth refresh failed: ${classification.message}`,
        status: res.status,
        code: classification.code === "unknown" ? "oauth_error" : classification.code,
        retryable: classification.retryable,
        reason: parseGoogleErrorPayload(parsed).reason,
        details: parsed,
      });
    }
  }

  private buildRequestUrl(pathname: string, query: Record<string, string | number | boolean | undefined>): URL {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async request<T>(opts: {
    method: GoogleCalendarHttpMethod;
    pathname: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  }): Promise<T> {
    let forceTokenRefresh = false;

    for (let attempt = 0; attempt < CALENDAR_REQUEST_MAX_ATTEMPTS; attempt += 1) {
      const accessToken = await this.getAccessToken(forceTokenRefresh);
      forceTokenRefresh = false;

      const url = this.buildRequestUrl(opts.pathname, opts.query ?? {});
      const hasBody = opts.body !== undefined;
      const res = await fetch(url, {
        method: opts.method,
        headers: hasBody
          ? {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
            }
          : {
              authorization: `Bearer ${accessToken}`,
            },
        body: hasBody ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      const { rawText, parsed } = await readResponseBody(res);
      if (res.ok) {
        if (!rawText) {
          return null as T;
        }
        return parsed as T;
      }

      if (res.status === 401) {
        if (attempt < CALENDAR_REQUEST_MAX_ATTEMPTS - 1) {
          forceTokenRefresh = true;
          continue;
        }
      }

      const classification = classifyStatus(res.status, parsed);
      const retryAfterMs = resolveRetryAfterMs(res.headers.get("retry-after"));
      const canRetry = classification.retryable && attempt < CALENDAR_REQUEST_MAX_ATTEMPTS - 1;
      if (canRetry) {
        await sleep(computeBackoffMs(attempt, retryAfterMs));
        continue;
      }

      const parsedError = parseGoogleErrorPayload(parsed);
      throw new GoogleCalendarApiError({
        message: classification.message,
        status: res.status,
        code: classification.code,
        retryable: classification.retryable,
        reason: parsedError.reason,
        details: parsed,
      });
    }

    throw new Error("Google Calendar request exhausted retry budget.");
  }

  private async eventsList(params: GoogleCalendarEventsListParams = {}): Promise<GoogleCalendarEventsListResponse> {
    const calendarId = this.resolveCalendarId(params.calendarId);
    const response = await this.request<GoogleCalendarEventsListResponse>({
      method: "GET",
      pathname: `/calendars/${encodeURIComponent(calendarId)}/events`,
      query: {
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        maxResults: params.maxResults,
        pageToken: params.pageToken,
        q: params.q,
        orderBy: params.orderBy,
        singleEvents: params.singleEvents,
        showDeleted: params.showDeleted,
        timeZone: params.timeZone ?? this.defaultTimeZone,
      },
    });
    const items = Array.isArray(response.items) ? response.items : [];
    return {
      ...response,
      items,
    };
  }

  private async eventsGet(params: GoogleCalendarEventsGetParams): Promise<GoogleCalendarEvent> {
    const calendarId = this.resolveCalendarId(params.calendarId);
    return this.request<GoogleCalendarEvent>({
      method: "GET",
      pathname: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}`,
      query: {
        timeZone: params.timeZone ?? this.defaultTimeZone,
      },
    });
  }

  private async eventsInsert(params: GoogleCalendarEventsInsertParams): Promise<GoogleCalendarEvent> {
    const calendarId = this.resolveCalendarId(params.calendarId);
    return this.request<GoogleCalendarEvent>({
      method: "POST",
      pathname: `/calendars/${encodeURIComponent(calendarId)}/events`,
      query: {
        sendUpdates: params.sendUpdates,
        conferenceDataVersion: params.conferenceDataVersion,
      },
      body: params.event,
    });
  }

  private async eventsPatch(params: GoogleCalendarEventsPatchParams): Promise<GoogleCalendarEvent> {
    const calendarId = this.resolveCalendarId(params.calendarId);
    return this.request<GoogleCalendarEvent>({
      method: "PATCH",
      pathname: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}`,
      query: {
        sendUpdates: params.sendUpdates,
        conferenceDataVersion: params.conferenceDataVersion,
      },
      body: params.event,
    });
  }

  private async eventsDelete(
    params: GoogleCalendarEventsDeleteParams,
  ): Promise<{ deleted: true; eventId: string; calendarId: string }> {
    const calendarId = this.resolveCalendarId(params.calendarId);
    await this.request<null>({
      method: "DELETE",
      pathname: `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}`,
      query: {
        sendUpdates: params.sendUpdates,
      },
    });
    return {
      deleted: true,
      eventId: params.eventId,
      calendarId,
    };
  }
}

export function createGoogleCalendarClient(opts: GoogleCalendarClientOptions): GoogleCalendarClient {
  return new GoogleCalendarRuntime(opts).toClient();
}
