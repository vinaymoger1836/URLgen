/**
 * The redirect hot path.
 *
 * Budget: a KV hit answers with zero origin calls and zero awaits on anything the
 * visitor is not waiting for. Work that can be deferred goes in `ctx.waitUntil()`.
 * Work that is expensive — User-Agent parsing above all — belongs at the origin,
 * where there is no 10ms CPU ceiling.
 *
 * Click tracking is Phase 3 and attaches to `ctx.waitUntil()` at the same place
 * the write-back does.
 */

import { isWellFormedSlug, type KvLinkValue } from "@urlgen/shared";

import type { Env } from "./env.js";
import { readCachedLink, writeBackLink } from "./kv.js";
import { evaluateLink, type LinkOutcome } from "./link.js";
import { logError } from "./log.js";
import { resolveFromOrigin } from "./origin.js";
import { errorPage, methodNotAllowed, redirectTo } from "./responses.js";

export type { Env };

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

    const cached = await readCachedLink(env, slug);
    if (cached !== undefined) {
      return respond(slug, evaluateLink(cached, Date.now()));
    }

    return await resolveOnMiss(env, ctx, slug);
  },
} satisfies ExportedHandler<Env>;

/**
 * The cold path.
 *
 * Only a genuinely resolvable link is written back. Negative results are not
 * cached on purpose: the origin pushes an updated blob into KV whenever a link is
 * edited or disabled, so the abuse case is already covered at the edge without
 * negative caching — and negative caching is where a re-enabled link would stay
 * dead until a TTL nobody remembers setting finally expired.
 */
async function resolveOnMiss(env: Env, ctx: ExecutionContext, slug: string): Promise<Response> {
  const resolution = await resolveFromOrigin(env, slug);

  switch (resolution.kind) {
    case "found": {
      const outcome = evaluateLink(resolution.value, Date.now());
      if (outcome.kind === "redirect") {
        ctx.waitUntil(cacheResolved(env, slug, resolution.value));
      }
      return respond(slug, outcome);
    }
    case "gone":
      return errorPage(resolution.reason);
    case "missing":
      return errorPage("not-found");
    case "unavailable":
      return errorPage("unavailable");
  }
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
    case "corrupt":
      /* Answer as if it does not exist — the visitor gains nothing from knowing
         the cache is broken, and an operator needs to. */
      logError("link_target_rejected", { slug, detail: outcome.detail });
      return errorPage("not-found");
  }
}
