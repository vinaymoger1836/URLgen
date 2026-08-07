/**
 * The redirect hot path.
 *
 * Budget: a KV hit answers with zero origin calls and zero awaits on anything the
 * visitor is not waiting for. Work that can be deferred goes in `ctx.waitUntil()`.
 * Work that is expensive — User-Agent parsing above all — belongs at the origin,
 * where there is no 10ms CPU ceiling.
 *
 * Two things ride on `ctx.waitUntil()`: the KV write-back on a cache miss, and the
 * click event. Neither can delay or fail the 302.
 */

import { isWellFormedSlug, type KvLinkValue } from "@urlgen/shared";

import { buildClickEvent, trackClick } from "./click.js";
import type { Env } from "./env.js";
import { readCachedLink, writeBackLink } from "./kv.js";
import { evaluateLink, type LinkOutcome } from "./link.js";
import { logError } from "./log.js";
import { resolveFromOrigin } from "./origin.js";
import { errorPage, methodNotAllowed, redirectTo } from "./responses.js";

export type { Env };

/**
 * Everything the resolve step can conclude.
 *
 * `LinkOutcome` stays exactly what a *blob* can say about itself — `evaluateLink`
 * is pure and must not gain a return value it can never produce. "The origin did
 * not answer" is a property of the lookup, not of the link, so it is added here.
 */
type ResolveOutcome = LinkOutcome | { kind: "unavailable" };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed();
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response("urlgen edge is running\n", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const slug = url.pathname.slice(1);

    /* Reject impossible slugs before spending a KV read against the daily quota.
       Bots probe `/wp-login.php` and `/.env` constantly; none of that should cost
       a lookup. */
    if (!isWellFormedSlug(slug)) {
      return errorPage("not-found");
    }

    const now = Date.now();
    const outcome = await resolve(request, env, ctx, slug, now);

    if (outcome.kind === "redirect") {
      recordClick(request, env, ctx, slug, now);
    }

    return respond(slug, outcome);
  },
} satisfies ExportedHandler<Env>;

/** Answers from the edge cache, falling through to the origin on a miss. */
async function resolve(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  slug: string,
  now: number,
): Promise<LinkOutcome> {
  const cached = await readCachedLink(env, slug);
  if (cached !== undefined) {
    return evaluateLink(cached, now);
  }

  return await resolveOnMiss(env, ctx, slug, now);
}

/**
 * The cold path.
 *
 * Only a genuinely resolvable link is written back. Negative results are not
 * cached on purpose: the origin pushes an updated blob into KV whenever a link is
 * edited or disabled, so the abuse case is already covered at the edge without
 * negative caching — and negative caching is where a re-enabled link would stay
 * dead until a TTL nobody remembers setting finally expired.
 */
async function resolveOnMiss(
  env: Env,
  ctx: ExecutionContext,
  slug: string,
  now: number,
): Promise<LinkOutcome> {
  const resolution = await resolveFromOrigin(env, slug);

  switch (resolution.kind) {
    case "found": {
      const outcome = evaluateLink(resolution.value, now);
      if (outcome.kind === "redirect") {
        ctx.waitUntil(cacheResolved(env, slug, resolution.value));
      }
      return outcome;
    }
    case "gone":
      return { kind: "gone", reason: resolution.reason };
    case "missing":
      return { kind: "missing" };
    case "unavailable":
      return { kind: "unavailable" };
  }
}

/**
 * Queues the click for the origin, after the response is already on its way.
 *
 * `HEAD` is deliberately not counted. Link-preview bots, uptime checkers and
 * security scanners all use it, and none of them is a visitor — counting them
 * would inflate every chart in the dashboard with traffic nobody sent.
 */
function recordClick(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  slug: string,
  now: number,
): void {
  if (request.method !== "GET") {
    return;
  }

  ctx.waitUntil(trackClick(env, buildClickEvent(request, slug, now)));
}

/** Populates the edge cache after the response has already gone out. */
async function cacheResolved(env: Env, slug: string, value: KvLinkValue): Promise<void> {
  await writeBackLink(env, slug, value);
}

/** Maps a decision to the response a visitor sees. */
function respond(slug: string, outcome: LinkOutcome): Response {
  switch (outcome.kind) {
    case "redirect":
      return redirectTo(outcome.targetUrl);
    case "gone":
      return errorPage(outcome.reason);
    case "missing":
      return errorPage("not-found");
    case "unavailable":
      return errorPage("unavailable");
    case "corrupt":
      /* Answer as if it does not exist — the visitor gains nothing from knowing
         the cache is broken, and an operator needs to. */
      logError("link_target_rejected", { slug, detail: outcome.detail });
      return errorPage("not-found");
  }
}
