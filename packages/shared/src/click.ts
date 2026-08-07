/**
 * The click-tracking wire contract between the edge worker and the origin.
 *
 * Only the *raw* facts live here — the things that exist at the edge and nowhere
 * else. Everything derived (device type, browser, OS, referrer host, visitor hash)
 * is computed at the origin, because the Worker has a 10ms CPU budget and
 * User-Agent parsing is the single most expensive thing this pipeline does.
 *
 * Shared rather than duplicated because a field the Worker renames is a field the
 * origin silently stops recording — and nothing would fail, the column would just
 * go empty.
 */

import { z } from "zod";

/**
 * Upper bounds on the two attacker-controlled strings.
 *
 * The Worker truncates to these lengths before sending, so the schema bound is a
 * backstop against a hand-crafted POST rather than a limit real traffic can hit.
 * Truncating beats rejecting: a 4KB User-Agent is a weird client, not a reason to
 * lose the click.
 */
export const MAX_USER_AGENT_LENGTH = 512;
export const MAX_REFERRER_LENGTH = 2048;

/**
 * One click, as the edge sees it.
 *
 * `ts` is stamped at the edge, not at the origin: the event may sit in the Redis
 * buffer for seconds, and an analytics timestamp that drifts with queue depth is
 * worse than useless.
 */
export const clickEventSchema = z.object({
  /** Idempotency key, minted at the edge — see `clickBatchToken` for what uses it. */
  id: z.string().min(1).max(64),
  slug: z.string().min(1).max(64),
  /** Epoch milliseconds. */
  ts: z.number().int().positive(),
  /** `request.cf.country` — two-letter code, or "XX" when Cloudflare cannot tell. */
  country: z.string().max(8).optional(),
  city: z.string().max(128).optional(),
  /** IANA zone from `request.cf.timezone`, e.g. "Asia/Kolkata". */
  timezone: z.string().max(64).optional(),
  /** The Cloudflare PoP that served the redirect, e.g. "BOM". An ops signal. */
  colo: z.string().max(16).optional(),
  /** Raw User-Agent. Parsed at the origin, never stored. */
  userAgent: z.string().max(MAX_USER_AGENT_LENGTH).optional(),
  /** Raw `Referer` header. Reduced to a host at the origin, never stored whole. */
  referrer: z.string().max(MAX_REFERRER_LENGTH).optional(),
  /**
   * The visitor's IP.
   *
   * Travels exactly one hop — edge to origin, over TLS — and is destroyed as soon
   * as the visitor hash is computed. It is never logged, never buffered, and never
   * written to ClickHouse. See `visitor-hash.ts` at the origin.
   */
  ip: z.string().max(64).optional(),
});

export type ClickEvent = z.infer<typeof clickEventSchema>;

/** The path the Worker posts a click to. Shared so the two sides cannot drift. */
export const CLICK_INGEST_PATH = "/ingest/click";
