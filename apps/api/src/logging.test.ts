/**
 * What reaches the log.
 *
 * These build a server with a real (non-`false`) logger writing into a buffer, so
 * the assertions are over the bytes pino actually emitted rather than over the
 * configuration that was supposed to produce them.
 */

import { Writable } from "node:stream";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { InMemoryLinkRepository } from "./repositories/in-memory-link-repository.js";
import { InMemoryRateLimiter } from "./repositories/rate-limiter.js";
import { buildServer } from "./server.js";

let app: FastifyInstance;

/** Collects everything the logger writes. */
function capture(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

afterEach(async () => {
  await app.close();
});

describe("request logging", () => {
  it("never writes the client address", async () => {
    /*
     * Fastify's default `req` serializer logs `remoteAddress` and `remotePort`.
     * That is harmless while `request.ip` is the socket peer — behind Cloudflare,
     * Cloudflare — and stops being harmless the moment `TRUSTED_PROXIES` is
     * configured, because `remoteAddress` then resolves to the **visitor's real
     * address** and every request line becomes a stored IP. That would quietly
     * undo the property the entire visitor-hash scheme exists to guarantee.
     */
    const log = capture();
    app = buildServer(
      /* `development` rather than `test`, because a test config disables logging
         entirely and this test would then assert over an empty string and pass. */
      loadConfig({ NODE_ENV: "development", LOG_LEVEL: "info", TRUSTED_PROXIES: "127.0.0.1" }),
      {
        linkRepository: new InMemoryLinkRepository(),
        rateLimiter: new InMemoryRateLimiter(),
        loggerDestination: log.stream,
      },
    );
    await app.ready();

    await app.inject({
      method: "GET",
      url: "/health",
      remoteAddress: "203.0.113.7",
      headers: { "x-forwarded-for": "198.51.100.22", "cf-connecting-ip": "198.51.100.22" },
    });

    const text = log.text();
    expect(text).toContain("/health");
    expect(text).not.toContain("203.0.113.7");
    expect(text).not.toContain("198.51.100.22");
    expect(text).not.toContain("remoteAddress");
  });

  it("keeps the request id, which correlates lines and identifies nobody", async () => {
    const log = capture();
    app = buildServer(loadConfig({ NODE_ENV: "development", LOG_LEVEL: "info" }), {
      linkRepository: new InMemoryLinkRepository(),
      rateLimiter: new InMemoryRateLimiter(),
      loggerDestination: log.stream,
    });
    await app.ready();

    await app.inject({ method: "GET", url: "/health" });

    expect(log.text()).toContain("reqId");
  });

  it("strips credential-bearing headers", async () => {
    const log = capture();
    app = buildServer(
      loadConfig({ NODE_ENV: "development", LOG_LEVEL: "info", ADMIN_API_TOKEN: "z".repeat(40) }),
      {
        linkRepository: new InMemoryLinkRepository(),
        rateLimiter: new InMemoryRateLimiter(),
        loggerDestination: log.stream,
      },
    );
    await app.ready();

    await app.inject({
      method: "GET",
      url: "/admin/abuse",
      headers: {
        "x-admin-token": "z".repeat(40),
        "x-internal-token": "secret-internal-value",
        authorization: "Bearer secret-bearer-value",
      },
    });

    const text = log.text();
    expect(text).not.toContain("z".repeat(40));
    expect(text).not.toContain("secret-internal-value");
    expect(text).not.toContain("secret-bearer-value");
  });
});
