/**
 * The edge cache tier.
 *
 * KV reads are cheap (100k/day free) and KV writes are not (1k/day) — writes are
 * the scarce resource in this whole architecture, so every write here has to earn
 * itself.
 */

import {
  kvBackstopTtlSeconds,
  kvLinkKey,
  kvLinkValueSchema,
  type KvLinkValue,
} from "@urlgen/shared";

import type { Env } from "./env.js";
import { describeError, logWarn } from "./log.js";

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
  const ttl = kvBackstopTtlSeconds(value, Date.now());
  if (ttl === undefined) {
    return;
  }

  try {
    await env.LINKS.put(kvLinkKey(slug), JSON.stringify(value), { expirationTtl: ttl });
  } catch (error) {
    logWarn("kv_write_back_failed", { slug, error: describeError(error) });
  }
}
