/**
 * The single error vocabulary shared by the edge worker, the API and the web app.
 *
 * Responses always use the shape `{ error: { code, message } }` so clients can
 * branch on a stable code instead of parsing prose, and so internal details never
 * reach a caller.
 */

export const ERROR_CODES = [
  "invalid_request",
  "invalid_url",
  "unsupported_protocol",
  "url_too_long",
  "slug_taken",
  "slug_reserved",
  "slug_invalid",
  "not_found",
  "link_not_found",
  "link_expired",
  "link_disabled",
  "unsafe_url",
  "rate_limited",
  "unauthorized",
  "forbidden",
  "internal_error",
  "upstream_unavailable",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
  };
}

/** Builds the standard error envelope. */
export function apiError(code: ErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}

/** HTTP status for each error code, so routes never hand-pick a status inconsistently. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400,
  invalid_url: 400,
  unsupported_protocol: 400,
  url_too_long: 400,
  slug_taken: 409,
  slug_reserved: 400,
  slug_invalid: 400,
  not_found: 404,
  link_not_found: 404,
  link_expired: 410,
  link_disabled: 410,
  unsafe_url: 422,
  rate_limited: 429,
  unauthorized: 401,
  forbidden: 403,
  internal_error: 500,
  upstream_unavailable: 503,
};
