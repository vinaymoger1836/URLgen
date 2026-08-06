/**
 * The edge cache tier.
 *
 * KV reads are cheap (100k/day free) and KV writes are not (1k/day) — writes are
 * the scarce resource in this whole architecture, so every write here has to earn
 * itself.
 */

import { kvLinkKey, kvLinkValueSchema, type KvLinkValue } from "@urlgen/shared";

import type { Env } from "./env.js";
import { describeError, logWarn } from "./log.js";

/**
 * Backstop lifetime for a written-back entry.
 *
 * Correctness does not depend on this: the origin overwrites the entry on edit and
 * purges it on delete, and expiry is checked from the blob on every read. The TTL
 * only bounds how long a link nobody has touched sits in the namespace.
 */
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Workers KV rejects any `expirationTtl` below 60 seconds. */
const MIN_TTL_SECONDS = 60;

/**
 * Reads a link blob from the edge cache.
 *
 * Returns undefined for a miss *and* for an unreadable entry — a corrupt value is
 * treated as absent so the request falls through to the origin and repairs itself,
 * rather than serving an error for as long as the bad entry lives.
 */
export async function readCachedLink(env: Env, slug: string): Promise<KvLinkValue | undefined> {
  let raw: unknown;
  try {
    raw = await env.LINKS.get<unknown>(kvLinkKey(slug), "json");
  } catch (error) {
    /* `get(..., "json")` throws on a value that is not valid JSON. */
    logWarn("kv_read_failed", { slug, error: describeError(error) });
    return undefined;
  }

  if (raw === null || raw === undefined) {
    return undefined;
  }

  const parsed = kvLinkValueSchema.safeParse(raw);
  if (!parsed.success) {
    logWarn("kv_value_invalid", { slug });
    return undefined;
  }

  return parsed.data;
}

/**
 * Writes a resolved link back into the edge cache.
 *
 * Call inside `ctx.waitUntil()` — the visitor's redirect must not wait on this.
 * Failures are swallowed: a failed write-back costs the next visitor one more
 * origin round trip, which is not worth failing a redirect that already succeeded.
 */
export async function writeBackLink(env: Env, slug: string, value: KvLinkValue): Promise<void> {
  const ttl = backstopTtlSeconds(value, Date.now());
  if (ttl === undefined) {
    /* Expiring within the minimum TTL window. Caching it would spend one of the
       day's 1000 writes on an entry that is about to be wrong. */
    return;
  }

  try {
    await env.LINKS.put(kvLinkKey(slug), JSON.stringify(value), { expirationTtl: ttl });
  } catch (error) {
    logWarn("kv_write_back_failed", { slug, error: describeError(error) });
  }
}

/**
 * Backstop TTL for a blob, or undefined when the entry is not worth writing.
 *
 * A link that expires sooner than the backstop gets the shorter lifetime, so the
 * dead entry evicts itself instead of lingering as a 410 the origin has to be
 * asked about again.
 */
export function backstopTtlSeconds(value: KvLinkValue, now: number): number | undefined {
  if (value.e === undefined) {
    return MAX_TTL_SECONDS;
  }

  const remaining = Math.floor((value.e - now) / 1000);
  if (remaining < MIN_TTL_SECONDS) {
    return undefined;
  }

  return Math.min(remaining, MAX_TTL_SECONDS);
}
