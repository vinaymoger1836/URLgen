import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { InMemoryLinkRepository } from "../repositories/in-memory-link-repository.js";
import { InMemoryRateLimiter } from "../repositories/rate-limiter.js";
import { buildServer } from "../server.js";

let app: FastifyInstance;

function build(env: Record<string, string> = {}): FastifyInstance {
  return buildServer(loadConfig({ NODE_ENV: "test", ...env }), {
    linkRepository: new InMemoryLinkRepository(),
    rateLimiter: new InMemoryRateLimiter(),
  });
}

afterEach(async () => {
  await app.close();
});

describe("security headers", () => {
  it("sets the restrictive defaults on every response", async () => {
    app = build();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("sets them on error responses too", async () => {
    /* The path most likely to reflect caller-supplied text back is the 404, which
       echoes the requested URL — so it is the one that most needs `nosniff`. */
    app = build();
    const response = await app.inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("does NOT send HSTS outside production", async () => {
    /* Not caution — a trap avoided. `Strict-Transport-Security` on a localhost
       response pins the developer's browser to https for localhost across every
       project on the machine, and outlives restarting the server. */
    app = build();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.headers["strict-transport-security"]).toBeUndefined();
  });

  it("sends HSTS in production", async () => {
    app = build({
      NODE_ENV: "production",
      INTERNAL_API_TOKEN: "x".repeat(32),
      VISITOR_HASH_SALT: "y".repeat(16),
    });
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.headers["strict-transport-security"]).toContain("max-age=31536000");
  });
});

describe("caching of owner-scoped responses", () => {
  it("marks /api responses no-store", async () => {
    app = build();
    const response = await app.inject({
      method: "GET",
      url: "/api/links",
      headers: { "x-owner-id": "alice" },
    });

    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("varies on x-owner-id WITHOUT discarding the CORS hook's Origin", async () => {
    /* `reply.header()` replaces rather than appends, so the naive one-liner would
       fix one cache-poisoning problem by creating the other: a shared cache with
       no `Vary: Origin` hands one origin's allow-header to a different origin. */
    app = build();
    const response = await app.inject({
      method: "GET",
      url: "/api/links",
      headers: { "x-owner-id": "alice", origin: "http://localhost:3000" },
    });

    const vary = String(response.headers["vary"]);
    expect(vary).toContain("Origin");
    expect(vary).toContain("x-owner-id");
  });

  it("leaves non-API paths alone", async () => {
    /* `/health` is a load-balancer probe, not personalized, and no-storing it says
       something untrue about it. */
    app = build();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.headers["cache-control"]).toBeUndefined();
  });

  it("is not fooled by a query string that starts with the prefix", async () => {
    app = build();
    const response = await app.inject({ method: "GET", url: "/health?next=/api/links" });

    expect(response.headers["cache-control"]).toBeUndefined();
  });
});
