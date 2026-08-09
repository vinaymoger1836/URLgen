/**
 * Response headers that hold whether or not anyone remembers they are there.
 *
 * This is a JSON API, so most of the familiar browser defences are being set to
 * their *most restrictive* value rather than tuned: the API serves no HTML, loads
 * no scripts, embeds nothing and is embedded by nothing. A policy of "none" is
 * both correct and the easiest thing to keep correct.
 *
 * - **`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none';
 *   form-action 'none'`.** A JSON body cannot execute a script — until something
 *   causes a browser to treat it as a document, which is precisely what the next
 *   header is about. `frame-ancestors` is the modern spelling of the clickjacking
 *   defence; `X-Frame-Options` rides along for the browsers that only know that one.
 * - **`X-Content-Type-Options: nosniff`.** The one that matters most here. Without
 *   it a browser may sniff a response body and decide a reflected value makes it
 *   HTML — turning an error message that contains a caller-supplied string into a
 *   rendered document on this API's own origin.
 * - **`Referrer-Policy: no-referrer`.** Slug and owner identifiers live in these
 *   paths; a referrer header would forward them to whatever the user visits next.
 * - **`Cache-Control: no-store` on `/api`.** Every response here is owner-scoped,
 *   and the scoping travels in `x-owner-id` — a request header no cache keys on. A
 *   shared cache would happily hand one owner's link list to the next caller of the
 *   same URL. `Vary: x-owner-id` would express that, but the honest answer for a
 *   personalized API is not to store it at all. (`Vary` is sent as well, for any
 *   cache that ignores `no-store`.)
 *
 * **HSTS is production-only, and that is not caution — it is a trap avoided.**
 * `Strict-Transport-Security` on a `localhost` response pins the developer's whole
 * browser to https for localhost, across every project on the machine, for the
 * max-age. It is not undone by restarting the dev server; it needs a manual visit
 * to the browser's HSTS settings. So it is sent only when the process is in
 * production, where the API is genuinely behind TLS.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** One year, the minimum a preload list will accept, with subdomains included. */
const HSTS = "max-age=31536000; includeSubDomains";

const BROWSER_PATH_PREFIX = "/api";

export interface SecurityHeadersOptions {
  /** HSTS is only sent when this is true. See the module note. */
  production: boolean;
}

export function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeadersOptions,
): void {
  app.addHook("onRequest", (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    reply
      .header("content-security-policy", CSP)
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY")
      .header("referrer-policy", "no-referrer");

    if (options.production) {
      reply.header("strict-transport-security", HSTS);
    }

    if (isBrowserPath(request.url)) {
      reply.header("cache-control", "no-store");
      appendVary(reply, "x-owner-id");
    }

    done();
  });
}

/**
 * Adds a field to `Vary` without discarding what is already there.
 *
 * `reply.header()` replaces, and the CORS hook has already written `Origin` — so
 * the obvious one-liner would fix one cache-poisoning problem by creating the
 * other. Order between the two hooks is registration order, which is exactly the
 * kind of coupling worth not depending on.
 */
function appendVary(reply: FastifyReply, field: string): void {
  const existing = reply.getHeader("vary");
  const parts = typeof existing === "string" && existing.length > 0 ? existing.split(", ") : [];

  if (!parts.includes(field)) {
    parts.push(field);
  }

  reply.header("vary", parts.join(", "));
}

/** Path only — a query string must not be able to smuggle the prefix check. */
function isBrowserPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  return path === BROWSER_PATH_PREFIX || path.startsWith(`${BROWSER_PATH_PREFIX}/`);
}
