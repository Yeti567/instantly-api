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

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
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
    const msg = obj.error ?? obj.message ?? obj.detail;
    if (typeof msg === "string") return msg.slice(0, 500);
    try {
      return JSON.stringify(obj).slice(0, 500);
    } catch {
      return "";
    }
  }
  return "";
}

export function campaignStatusLabel(status: unknown): string {
  if (status === null || status === undefined) return "Unknown";
  return CAMPAIGN_STATUS[String(status)] ?? `Unknown (${String(status)})`;
}
