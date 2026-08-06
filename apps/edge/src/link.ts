/**
 * Turns a cached link blob into a decision.
 *
 * Kept pure and separate from I/O because both the KV-hit path and the
 * cache-miss path funnel through it. Two copies of "is this link still good?"
 * would be two chances to drift, and the drift would only show up in production
 * on whichever path happened to be wrong.
 */

import { ALLOWED_PROTOCOLS, parseUrl, type KvLinkValue } from "@urlgen/shared";

export type LinkOutcome =
  | { kind: "redirect"; targetUrl: string }
  | { kind: "gone"; reason: "expired" | "disabled" }
  | { kind: "missing" }
  /** The blob parsed but its target is not a URL we are willing to emit. */
  | { kind: "corrupt"; detail: string };

/**
 * Decides what to do with a link blob at a given instant.
 *
 * Expiry is evaluated here on every read rather than left to the KV TTL, so an
 * expired link stops redirecting the moment it expires instead of whenever the
 * TTL happens to sweep.
 */
export function evaluateLink(value: KvLinkValue, now: number): LinkOutcome {
  switch (value.s) {
    case "deleted":
      /* Deleted is the owner removing their own link — indistinguishable from
         "never existed" to a visitor, on purpose. */
      return { kind: "missing" };
    case "disabled":
      return { kind: "gone", reason: "disabled" };
    case "expired":
      return { kind: "gone", reason: "expired" };
    case "active":
      break;
  }

  if (value.e !== undefined && value.e <= now) {
    return { kind: "gone", reason: "expired" };
  }

  /* Defence in depth against a poisoned or stale-format cache entry. The origin
     validates the target at creation, but KV is a cache and the edge must never
     become an open redirect to `javascript:` because something upstream slipped. */
  const target = parseUrl(value.u);
  if (target === undefined) {
    return { kind: "corrupt", detail: "target is not a parseable URL" };
  }
  if (!ALLOWED_PROTOCOLS.includes(target.protocol)) {
    return { kind: "corrupt", detail: "target protocol is not http(s)" };
  }

  return { kind: "redirect", targetUrl: value.u };
}
