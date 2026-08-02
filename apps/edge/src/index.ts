/**
 * The redirect hot path.
 *
 * Phase 0 wires the worker into the workspace and establishes the request shape.
 * The KV lookup, origin fallback with write-back, and click tracking arrive in
 * Phases 2 and 3 — this deliberately does not pretend to resolve links yet.
 */

import { isWellFormedSlug } from "@urlgen/shared";

export interface Env {
  /** Slug -> compact link blob. See `kvLinkValueSchema` in @urlgen/shared. */
  LINKS: KVNamespace;
  /** Origin API base, used on a KV miss. */
  ORIGIN_API_BASE: string;
  /** Shared secret for the internal resolve endpoint. Set via `wrangler secret put`. */
  INTERNAL_API_TOKEN?: string;
}

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response("urlgen edge is running\n", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const slug = url.pathname.slice(1);

    /* Reject impossible slugs before spending a KV read against the daily quota. */
    if (!isWellFormedSlug(slug)) {
      return notFound();
    }

    /* Phase 2 replaces this with: KV lookup -> 302, miss -> origin -> write-back. */
    return notFound();
  },
} satisfies ExportedHandler<Env>;

function notFound(): Response {
  return new Response("Link not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
