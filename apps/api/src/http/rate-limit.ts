/**
 * Applying rate limits to a request, and telling the caller about it.
 *
 * ## Two dimensions, both enforced
 *
 * Link creation is limited per client IP *and* per owner. Neither alone is
 * enough: an IP limit alone is defeated by a botnet or an open proxy pool, and an
 * owner limit alone is defeated by picking a new `x-owner-id` for every request —
 * which, until there is real authentication, costs an attacker nothing. Together
 * they mean a distributed attacker still has to spread across owners, and a single
 * owner still has to spread across addresses.
 *
 * The reported headers describe whichever limit is closest to running out, because
 * that is the one the caller will actually hit. Reporting the looser one would tell
 * a client it has 95 requests left immediately before refusing its next one.
 *
 * ## Failing open, deliberately
 *
 * If Redis cannot answer, the request is allowed and the failure is logged at
 * error level. The reasoning is the same shape as Safe Browsing's: this limiter
 * exists to blunt abuse, and refusing every write while Redis is down converts a
 * cache outage into a full write outage — for a control that has a coarser layer
 * above it (the Cloudflare rate-limiting rule, see `THREAT_MODEL.md`) and a
 * durable one below it (the abuse report + admin disable path).
 *
 * What it must never do is fail open *silently*, which is why there is no
 * in-process fallback limiter here: a per-replica limiter would keep emitting
 * confident `X-RateLimit-*` headers describing a limit nobody is enforcing.
 */

import { ERROR_STATUS, apiError } from "@urlgen/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { RateLimitDecision, RateLimitRule, RateLimiter } from "../repositories/rate-limiter.js";

/** One limit to apply, named so a rejection can say which dimension tripped. */
export interface RateLimitCheck {
  /** `create:ip` / `create:owner` — appears in the key and in the log line. */
  dimension: string;
  /** The identity being limited. Combined with `dimension` to form the Redis key. */
  identity: string;
  rule: RateLimitRule;
}

/**
 * Runs every check and sets the response headers.
 *
 * Returns `true` when the request may proceed. On a rejection the 429 has already
 * been sent, so the caller returns immediately without touching the reply again.
 */
export async function enforceRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  limiter: RateLimiter,
  checks: readonly RateLimitCheck[],
): Promise<boolean> {
  let tightest: { check: RateLimitCheck; decision: RateLimitDecision } | undefined;

  for (const check of checks) {
    let decision: RateLimitDecision;
    try {
      decision = await limiter.consume(`${check.dimension}:${check.identity}`, check.rule);
    } catch (error) {
      /* Loud, because this is a security control that has stopped working — and
         quiet enough not to leak the identity, which for the IP dimension is
         personal data we otherwise take care never to log. */
      request.log.error({ err: error, dimension: check.dimension }, "rate limiter unavailable");
      return true;
    }

    if (!decision.allowed) {
      sendRateLimited(reply, check, decision);
      request.log.warn({ dimension: check.dimension }, "rate limit exceeded");
      return false;
    }

    if (tightest === undefined || decision.remaining < tightest.decision.remaining) {
      tightest = { check, decision };
    }
  }

  if (tightest !== undefined) {
    setHeaders(reply, tightest.decision);
  }

  return true;
}

/**
 * The 429.
 *
 * `Retry-After` is in seconds and rounded *up*: rounding down would tell a
 * well-behaved client to retry just before capacity returns, and it would be
 * refused a second time for having done exactly what it was told.
 */
function sendRateLimited(
  reply: FastifyReply,
  check: RateLimitCheck,
  decision: RateLimitDecision,
): void {
  const retryAfterSeconds = Math.max(1, Math.ceil((decision.resetAtMs - Date.now()) / 1000));

  setHeaders(reply, decision);
  void reply
    .header("retry-after", String(retryAfterSeconds))
    .code(ERROR_STATUS.rate_limited)
    .send(
      apiError(
        "rate_limited",
        /* Names the dimension but not the limit's identity: telling a caller it was
           limited "per owner" is useful, telling it which owner is not its business. */
        `Too many requests (${check.dimension}). Retry in ${String(retryAfterSeconds)}s.`,
      ),
    );
}

function setHeaders(reply: FastifyReply, decision: RateLimitDecision): void {
  reply
    .header("x-ratelimit-limit", String(decision.limit))
    .header("x-ratelimit-remaining", String(decision.remaining))
    /* Epoch seconds, the form every other implementation of this header uses.
       A duration would be ambiguous with `Retry-After` sitting next to it. */
    .header("x-ratelimit-reset", String(Math.ceil(decision.resetAtMs / 1000)));
}

/**
 * The address a limit is charged to.
 *
 * `request.ip` is the socket peer unless `TRUSTED_PROXIES` says otherwise, which
 * is the point: with blanket proxy trust any direct client picks its own value by
 * setting `X-Forwarded-For`, and a per-IP limit keyed on that limits nothing.
 */
export function clientIp(request: FastifyRequest): string {
  return request.ip;
}
