/**
 * A click after the origin has enriched it — the row that reaches ClickHouse.
 *
 * This shape exists only at the origin, which is why it is not in
 * `@urlgen/shared`: the Worker sends raw facts (`ClickEvent`) and never sees a
 * parsed one, and keeping origin-only Zod schemas out of the shared barrel keeps
 * them out of the Worker's bundle.
 *
 * There is deliberately no IP field. The address arrives on the ingest request,
 * becomes a salted hash, and is gone before a row is ever constructed.
 */

import { z } from "zod";

/**
 * One enriched click.
 *
 * Parsed rather than trusted on the way *out* of Redis as well as in: a buffered
 * row is JSON that survived a process restart and possibly a deploy, so it is a
 * boundary like any other.
 */
export const clickRowSchema = z.object({
  /**
   * The edge's idempotency key.
   *
   * Buffered but never inserted — it exists to make a batch identifiable, so a
   * replayed flush produces a byte-identical block that ClickHouse can recognise
   * and drop. See `clickBatchToken`.
   */
  eventId: z.string().min(1),
  slug: z.string().min(1),
  /** Epoch milliseconds, stamped at the edge when the redirect was served. */
  ts: z.number().int().positive(),
  country: z.string(),
  city: z.string(),
  timezone: z.string(),
  colo: z.string(),
  deviceType: z.string(),
  browser: z.string(),
  os: z.string(),
  /** Host only — the path and query are dropped at parse time and never stored. */
  referrerHost: z.string(),
  /** Salted, daily-rotating. Not derivable back to an IP. */
  visitorHash: z.string().min(1),
});

export type ClickRow = z.infer<typeof clickRowSchema>;
