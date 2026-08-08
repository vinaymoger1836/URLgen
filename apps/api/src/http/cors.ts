/**
 * Cross-origin access for the dashboard, and for nothing else.
 *
 * The dashboard runs on its own origin (Vercel in production, `localhost:3000` in
 * development) and reads this API directly, so without CORS the browser blocks
 * every response and Phase 4 does not function at all. Phase 5 owns the wider
 * hardening pass; this is the part the dashboard cannot run without.
 *
 * Hand-rolled rather than pulled in as a plugin, because the entire policy is four
 * decisions and each one is a decision worth being able to point at:
 *
 * - **Allowlist only, echoed exactly.** The `Access-Control-Allow-Origin` header
 *   can name one origin or `*`, so a multi-origin allowlist works by echoing the
 *   request's origin back — but only after an exact match against the configured
 *   set. Echoing whatever arrived is the classic way this ends up equivalent to `*`.
 * - **`Vary: Origin`, always.** The response differs per origin, so a cache that
 *   does not know that will hand one origin's allow-header to another.
 * - **`/api` only.** `/internal/resolve` and `/ingest/click` are service-to-service
 *   calls from the Worker, authenticated with a shared token. A browser has no
 *   business preflighting them, and a token-bearing endpoint that answers
 *   preflights is a token-bearing endpoint someone will eventually call from a page.
 * - **No credentials.** Identity travels in `x-owner-id`, not a cookie, so
 *   `Access-Control-Allow-Credentials` is never sent — which also means a
 *   misconfiguration cannot turn into a session-riding request.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const ALLOWED_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const ALLOWED_HEADERS = "content-type, x-owner-id";

/** How long a browser may cache a preflight result. */
const MAX_AGE_SECONDS = 600;

/** Only the public API is reachable from a page. */
const BROWSER_PATH_PREFIX = "/api/";

export function registerCors(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  const allowed = new Set(allowedOrigins);

  app.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    if (!isBrowserPath(request.url)) {
      done();
      return;
    }

    const origin = headerValue(request.headers.origin);

    /* Sent whether or not the origin matched: the response genuinely varies by
       origin either way, and omitting it on a rejection is how a shared cache ends
       up serving the allowed origin's headers to everyone. */
    reply.header("vary", "Origin");

    if (origin !== undefined && allowed.has(origin)) {
      reply.header("access-control-allow-origin", origin);
    }

    if (request.method !== "OPTIONS") {
      done();
      return;
    }

    /* Answered here rather than by a route: a preflight for `DELETE /api/links/x`
       is an `OPTIONS` request, which no route declares, so routing it would produce
       a 404 the browser reads as "not allowed". A rejected origin still gets the
       204 — it simply arrives without the allow header, which is what makes the
       browser refuse the real request. */
    void reply
      .header("access-control-allow-methods", ALLOWED_METHODS)
      .header("access-control-allow-headers", ALLOWED_HEADERS)
      .header("access-control-max-age", String(MAX_AGE_SECONDS))
      .code(204)
      .send();
  });
}

function isBrowserPath(url: string): boolean {
  /* Compare the path only — a query string must not be able to smuggle the prefix
     check into matching something else. */
  const path = url.split("?")[0] ?? "";
  return path.startsWith(BROWSER_PATH_PREFIX) || path === "/api";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
