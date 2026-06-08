// Thin client for the Instantly.ai V2 API.
// Responsibilities: attach auth, build URLs, and turn API failures into clean,
// actionable messages. The API key is read from the environment on every call
// and is never logged or returned to the caller.

const BASE_URL = "https://api.instantly.ai/api/v2";

// Campaign status enum, from the V2 docs.
export const CAMPAIGN_STATUS: Record<string, string> = {
  "0": "Draft",
  "1": "Active",
  "2": "Paused",
  "3": "Completed",
  "4": "Running Subsequences",
  "-1": "Accounts Unhealthy",
  "-2": "Bounce Protect",
  "-99": "Account Suspended",
};

// Lead interest status enum (lt_interest_status), from the V2 docs.
// null is a special value that resets the lead back to a plain "Lead".
export const INTEREST_STATUS: Record<string, number | null> = {
  "Out of Office": 0,
  Interested: 1,
  "Meeting Booked": 2,
  "Meeting Completed": 3,
  Won: 4,
  "Not Interested": -1,
  "Wrong Person": -2,
  Lost: -3,
  "No Show": -4,
  "Reset to Lead": null,
};

// Instantly's campaign_schedule.timezone field is an AJV enum of specific IANA
// names, NOT the full database and NOT the Etc/GMT offsets generally. Sending
// an unlisted zone returns a bare HTTP 400 ("...timezone must be equal to one
// of the allowed values") — this was the real cause of the create_campaign
// failure. The set below was discovered empirically by probing the live API
// (America/Chicago is accepted; America/Toronto, America/Edmonton, New_York,
// Denver, Phoenix, and most Etc/GMT zones are NOT). Re-verify by re-running the
// probe if Instantly changes the enum.
export const INSTANTLY_TIMEZONES: ReadonlySet<string> = new Set<string>([
  // UTC offset zones Instantly accepts (only these few, not the full range).
  "Etc/GMT+12", "Etc/GMT+11", "Etc/GMT+10", "Etc/GMT-12", "Etc/GMT-13",
  // North America — the specific city representatives Instantly accepts.
  "America/Anchorage", // Alaska
  "America/Dawson", // Pacific
  "America/Boise", // Mountain (DST)
  "America/Chihuahua", // Mountain (Mexico)
  "America/Chicago", // Central
  "America/Regina", // Central, no DST (Saskatchewan)
  "America/Detroit", // Eastern
  "America/Bogota", // UTC-5, no DST
  "America/Caracas", // UTC-4
  "America/Glace_Bay", // Atlantic
  "America/St_Johns", // Newfoundland
  // Central / South America.
  "America/Santiago", "America/Sao_Paulo", "America/Godthab",
  "Atlantic/Cape_Verde",
  // Europe / Africa / Middle East.
  "Europe/Helsinki", "Europe/Istanbul", "Africa/Cairo", "Asia/Jerusalem",
  "Asia/Dubai", "Asia/Tehran", "Asia/Karachi", "Asia/Kolkata",
  "Asia/Kathmandu", "Asia/Dhaka", "Asia/Hong_Kong",
  // Australia / Pacific.
  "Australia/Perth", "Australia/Darwin", "Australia/Brisbane",
  "Australia/Adelaide", "Pacific/Auckland", "Pacific/Fiji",
]);

// Common IANA zones that callers (and AI skills) actually type but Instantly
// rejects, each mapped to the accepted representative for the same UTC offset
// and DST behavior. Canadian zones dominate because that is this connector's
// audience; mappings verified against the probed accepted set above.
export const TIMEZONE_ALIASES: Record<string, string> = {
  // Canada → accepted representative (same offset + DST rules).
  "America/Vancouver": "America/Dawson", // Pacific
  "America/Whitehorse": "America/Dawson",
  "America/Tijuana": "America/Dawson",
  "America/Los_Angeles": "America/Dawson",
  "America/Edmonton": "America/Boise", // Mountain
  "America/Calgary": "America/Boise",
  "America/Yellowknife": "America/Boise",
  "America/Denver": "America/Boise",
  "America/Phoenix": "America/Boise", // (Arizona has no DST; closest accepted)
  "America/Winnipeg": "America/Chicago", // Central
  "America/Mexico_City": "America/Chicago",
  "America/Toronto": "America/Detroit", // Eastern
  "America/Montreal": "America/Detroit",
  "America/Ottawa": "America/Detroit",
  "America/New_York": "America/Detroit",
  "America/Nassau": "America/Detroit",
  "America/Halifax": "America/Glace_Bay", // Atlantic
  "America/Moncton": "America/Glace_Bay",
  // A few common world zones → same-offset accepted representative.
  "America/Lima": "America/Bogota",
  "America/Panama": "America/Bogota",
  "America/Jamaica": "America/Bogota",
  "Asia/Shanghai": "Asia/Hong_Kong",
  "Asia/Singapore": "Asia/Hong_Kong",
  "Asia/Kuala_Lumpur": "Asia/Hong_Kong",
  "Asia/Taipei": "Asia/Hong_Kong",
  "Asia/Manila": "Asia/Hong_Kong",
  "Asia/Calcutta": "Asia/Kolkata",
  "Europe/Athens": "Europe/Helsinki",
  "Europe/Bucharest": "Europe/Helsinki",
  "Europe/Kyiv": "Europe/Helsinki",
  "Europe/Kiev": "Europe/Helsinki",
  "Australia/Sydney": "Australia/Brisbane",
  "Australia/Melbourne": "Australia/Brisbane",
};

// Resolve a caller-supplied timezone to one Instantly accepts. Returns the
// accepted zone (possibly remapped from an alias), or a clear error naming the
// bad value — never a silent pass-through that would 400.
export function resolveTimezone(
  input: string,
): { timezone: string } | { error: string } {
  const trimmed = input.trim();
  const mapped = TIMEZONE_ALIASES[trimmed] ?? trimmed;
  if (INSTANTLY_TIMEZONES.has(mapped)) return { timezone: mapped };
  return {
    error:
      `Timezone "${input}" is not in Instantly's accepted list, so the campaign ` +
      `would be rejected with an HTTP 400. Instantly only accepts a specific set ` +
      `of zones. Use one of: America/Dawson (Pacific), America/Boise (Mountain), ` +
      `America/Chicago (Central), America/Detroit (Eastern), America/Glace_Bay ` +
      `(Atlantic), America/St_Johns (Newfoundland), Europe/Helsinki, Asia/Dubai, ` +
      `Asia/Kolkata, or Australia/Brisbane.`,
  };
}

export class InstantlyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "InstantlyError";
  }
}

function getApiKey(): string {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key) {
    throw new InstantlyError(
      500,
      "Server is not configured: INSTANTLY_API_KEY is missing. Set it in the deployment environment.",
    );
  }
  return key;
}

type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
};

export async function instantlyRequest<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = new URL(BASE_URL + path);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }

  // Resolve the key before the try block so a missing-key error surfaces as a
  // configuration error, not as a masked network error.
  const apiKey = getApiKey();

  // Only send a Content-Type when there is actually a body. Instantly's
  // bodyless endpoints (DELETE, activate, pause) reject a request that declares
  // application/json but has an empty/`{}` body ("body must be null"), so a bare
  // request with no Content-Type is required for them.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (e) {
    // Network level failure (DNS, timeout, etc). Do not leak internals.
    throw new InstantlyError(
      502,
      "Could not reach the Instantly API (network error). Please try again.",
    );
  }

  const raw = await res.text();
  let data: unknown = undefined;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }

  if (!res.ok) {
    throw new InstantlyError(res.status, friendlyError(res.status, data));
  }

  return data as T;
}

function friendlyError(status: number, data: unknown): string {
  const detail = extractDetail(data);
  const suffix = detail ? ` Detail: ${detail}` : "";
  switch (status) {
    case 400:
      return `Instantly rejected the request (HTTP 400, bad input). Check the field values you sent.${suffix}`;
    case 401:
    case 403:
      return `Instantly rejected the API key (HTTP ${status}). Confirm INSTANTLY_API_KEY is a valid V2 key with the required scopes.${suffix}`;
    case 404:
      return `Instantly could not find that resource (HTTP 404). Check the id is correct and belongs to this workspace.${suffix}`;
    case 422:
      return `Instantly could not process the request (HTTP 422, validation error).${suffix}`;
    case 429:
      return `Instantly rate limit reached (HTTP 429). Wait a moment and try again.${suffix}`;
    default:
      if (status >= 500) {
        return `Instantly had a server error (HTTP ${status}). This is on their side, try again shortly.${suffix}`;
      }
      return `Instantly API error (HTTP ${status}).${suffix}`;
  }
}

function extractDetail(data: unknown): string {
  if (!data) return "";
  if (typeof data === "string") return data.slice(0, 500);
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    // Instantly's validation errors put the useful field-level detail in
    // `message` (AJV style), e.g. ".../timezone must be equal to one of the
    // allowed values". Prefer it, falling back to the whole body.
    const msg = obj.message ?? obj.error ?? obj.detail;
    if (typeof msg === "string" && msg && msg !== "Bad Request") {
      return msg.slice(0, 500);
    }
    try {
      return JSON.stringify(obj).slice(0, 500);
    } catch {
      return typeof msg === "string" ? msg.slice(0, 500) : "";
    }
  }
  return "";
}

export function campaignStatusLabel(status: unknown): string {
  if (status === null || status === undefined) return "Unknown";
  return CAMPAIGN_STATUS[String(status)] ?? `Unknown (${String(status)})`;
}
