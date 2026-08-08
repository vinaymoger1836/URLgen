/**
 * The dashboard's client for the origin API.
 *
 * Every response is parsed with the same Zod schema the API produced it from, so a
 * contract change breaks here — loudly, at the boundary — rather than three
 * components later as an undefined property in a chart.
 *
 * The browser calls the origin directly (`NEXT_PUBLIC_API_BASE`), which is what the
 * CORS allowlist on the API exists for. Identity is the `x-owner-id` header, the
 * same placeholder the API has used since Phase 1; real authentication replaces
 * this one header and nothing else.
 */

import {
  analyticsResponseSchema,
  analyticsTotalsResponseSchema,
  linkApiResponseSchema,
  linkListResponseSchema,
  type AnalyticsPreset,
  type AnalyticsResponse,
  type AnalyticsTotalsResponse,
  type ErrorCode,
  type LinkApiResponse,
  type LinkListResponse,
} from "@urlgen/shared";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";
const OWNER_ID = process.env.NEXT_PUBLIC_OWNER_ID ?? "public";

/**
 * A failed request, carrying the API's stable error code.
 *
 * The code is what the UI branches on; the message is what it shows. A transport
 * failure — the API is not running, the network is down — has no code, which is
 * itself the distinction the UI needs to say "cannot reach the API" rather than
 * inventing a server-side reason.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly code: ErrorCode | undefined;

  public constructor(message: string, status: number, code?: ErrorCode) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** True when the API answered and said the thing does not exist. */
  public get isNotFound(): boolean {
    return this.status === 404;
  }
}

interface ParsedSchema<T> {
  parse(value: unknown): T;
}

async function request<T>(
  path: string,
  schema: ParsedSchema<T>,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "x-owner-id": OWNER_ID,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      /* The API is the cache — it holds a short-TTL entry keyed on a quantized
         clock. A second cache in the browser would only make the dashboard show a
         staler number than the one the server was willing to give it. */
      cache: "no-store",
    });
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? `Could not reach the API: ${error.message}` : "Could not reach the API",
      0,
    );
  }

  if (!response.ok) {
    throw await describeFailure(response);
  }

  if (response.status === 204) {
    /* No body to read. Calling `.json()` on it throws, which would turn a
       successful delete into a failed one. */
    return schema.parse(undefined);
  }

  return schema.parse(await response.json());
}

/**
 * Reads the API's `{ error: { code, message } }` envelope, tolerating anything else.
 *
 * A gateway or a proxy can answer instead of the API, and its body will not be that
 * envelope. Falling back to the status keeps a 502 from an intermediary looking like
 * a parser crash in the dashboard.
 */
async function describeFailure(response: Response): Promise<ApiError> {
  const fallback = `Request failed (${response.status.toString()})`;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new ApiError(fallback, response.status);
  }

  if (!isErrorEnvelope(body)) {
    return new ApiError(fallback, response.status);
  }

  const { code, message } = body.error;
  const parsedMessage = typeof message === "string" ? message : fallback;

  return code === undefined
    ? new ApiError(parsedMessage, response.status)
    : new ApiError(parsedMessage, response.status, code);
}

/**
 * `code` is narrowed to `ErrorCode` without checking it against the list.
 *
 * The API is the only thing that produces this envelope and the vocabulary is
 * shared, so a string here is one of those codes. Validating it would mean
 * rejecting an error response because the error code was new — turning a
 * forward-compatible field into a hard failure on the path that is already failing.
 */
function isErrorEnvelope(
  value: unknown,
): value is { error: { code?: ErrorCode; message?: unknown } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null
  );
}

export interface CreateLinkInput {
  url: string;
  customSlug?: string | undefined;
  expiresAt?: string | undefined;
}

export interface AnalyticsQueryInput {
  range: AnalyticsPreset;
  /** The viewer's own zone, so buckets land on their midnights. */
  timeZone: string;
}

function analyticsSearch({ range, timeZone }: AnalyticsQueryInput): string {
  return new URLSearchParams({ range, tz: timeZone }).toString();
}

export const api = {
  listLinks(): Promise<LinkListResponse> {
    return request("/api/links", linkListResponseSchema);
  },

  createLink(input: CreateLinkInput): Promise<LinkApiResponse> {
    return request("/api/links", linkApiResponseSchema, {
      method: "POST",
      body: JSON.stringify({
        url: input.url,
        ...(input.customSlug !== undefined && input.customSlug !== ""
          ? { customSlug: input.customSlug }
          : {}),
        ...(input.expiresAt !== undefined && input.expiresAt !== ""
          ? { expiresAt: new Date(input.expiresAt).toISOString() }
          : {}),
      }),
    });
  },

  async deleteLink(slug: string): Promise<void> {
    const noBody = { parse: () => undefined };
    await request(`/api/links/${encodeURIComponent(slug)}`, noBody, { method: "DELETE" });
  },

  getLink(slug: string): Promise<LinkApiResponse> {
    return request(`/api/links/${encodeURIComponent(slug)}`, linkApiResponseSchema);
  },

  analytics(slug: string, query: AnalyticsQueryInput): Promise<AnalyticsResponse> {
    return request(
      `/api/analytics/${encodeURIComponent(slug)}?${analyticsSearch(query)}`,
      analyticsResponseSchema,
    );
  },

  totals(query: AnalyticsQueryInput): Promise<AnalyticsTotalsResponse> {
    return request(`/api/analytics?${analyticsSearch(query)}`, analyticsTotalsResponseSchema);
  },
};

/** The viewer's IANA zone, which is what every window is bucketed in. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
