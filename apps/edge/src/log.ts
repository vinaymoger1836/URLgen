/**
 * Structured logging for the Worker.
 *
 * Only abnormal paths log. A successful redirect writes nothing: logging is not
 * free against a 10ms CPU budget, and the click is already being recorded by the
 * analytics pipeline, which is where per-request facts belong.
 *
 * Never pass a target URL here — a shortened URL can carry a session token in its
 * query string. Slugs are safe; the thing the slug points at is not.
 */

type Fields = Record<string, string | number | boolean | undefined>;

export function logWarn(event: string, fields: Fields = {}): void {
  console.warn(JSON.stringify({ level: "warn", event, ...fields }));
}

export function logError(event: string, fields: Fields = {}): void {
  console.error(JSON.stringify({ level: "error", event, ...fields }));
}

/** Reduces an unknown thrown value to something safe to put in a log line. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return typeof error === "string" ? error : "unknown error";
}
