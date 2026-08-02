import type { LinkRecord } from "@urlgen/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { InMemoryLinkRepository } from "../repositories/in-memory-link-repository.js";
import { buildServer } from "../server.js";

const TOKEN = "t".repeat(40);

function link(overrides: Partial<LinkRecord> = {}): LinkRecord {
  return {
    slug: "abc1234",
    targetUrl: "https://example.com/destination",
    ownerId: "alice",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    urlHash: "hash-value",
    clickCount: 0,
    ...overrides,
  };
}

let app: FastifyInstance;
let repository: InMemoryLinkRepository;

function buildWith(token: string | undefined): FastifyInstance {
  repository = new InMemoryLinkRepository();
  const config = loadConfig({
    NODE_ENV: "test",
    ...(token !== undefined ? { INTERNAL_API_TOKEN: token } : {}),
  });
  return buildServer(config, { linkRepository: repository });
}

function resolve(slug: string, token?: string) {
  return app.inject({
    method: "GET",
    url: `/internal/resolve/${slug}`,
    ...(token !== undefined ? { headers: { "x-internal-token": token } } : {}),
  });
}

describe("GET /internal/resolve/:slug", () => {
  describe("with a token configured", () => {
    beforeEach(async () => {
      app = buildWith(TOKEN);
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("returns the compact KV blob for an active link", async () => {
      repository.seed(link());

      const response = await resolve("abc1234", TOKEN);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ u: "https://example.com/destination", s: "active" });
    });

    it("includes the expiry as epoch milliseconds when set", async () => {
      repository.seed(link({ expiresAt: "2030-01-01T00:00:00.000Z" }));

      const response = await resolve("abc1234", TOKEN);

      expect(response.json<{ e: number }>().e).toBe(Date.parse("2030-01-01T00:00:00.000Z"));
    });

    it("leaks nothing internal to the edge", async () => {
      repository.seed(link());

      const body = response_body(await resolve("abc1234", TOKEN));

      expect(body).not.toHaveProperty("ownerId");
      expect(body).not.toHaveProperty("urlHash");
      expect(body).not.toHaveProperty("targetUrl");
    });

    it("is never cached", async () => {
      repository.seed(link());
      const response = await resolve("abc1234", TOKEN);
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("rejects a missing, wrong, or empty token", async () => {
      repository.seed(link());

      expect((await resolve("abc1234")).statusCode).toBe(401);
      expect((await resolve("abc1234", "wrong")).statusCode).toBe(401);
      expect((await resolve("abc1234", "")).statusCode).toBe(401);
      /* Same length as the real token, different content — exercises the
         constant-time comparison rather than the length short-circuit. */
      expect((await resolve("abc1234", "x".repeat(40))).statusCode).toBe(401);
    });

    it("404s for an unknown or deleted link", async () => {
      expect((await resolve("zzzzzzz", TOKEN)).statusCode).toBe(404);

      repository.seed(link({ status: "deleted" }));
      expect((await resolve("abc1234", TOKEN)).statusCode).toBe(404);
    });

    it("410s for a disabled link", async () => {
      repository.seed(link({ status: "disabled" }));

      const response = await resolve("abc1234", TOKEN);

      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({ error: { code: "link_disabled" } });
    });

    it("410s for an expired link even though DynamoDB TTL has not swept it", async () => {
      repository.seed(link({ expiresAt: "2020-01-01T00:00:00.000Z" }));

      const response = await resolve("abc1234", TOKEN);

      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({ error: { code: "link_expired" } });
    });

    it("404s a malformed slug without a storage lookup", async () => {
      expect((await resolve("not%20a%20slug", TOKEN)).statusCode).toBe(404);
    });
  });

  describe("without a token configured", () => {
    beforeEach(async () => {
      app = buildWith(undefined);
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("refuses to serve rather than resolving unauthenticated", async () => {
      repository.seed(link());

      const response = await resolve("abc1234", TOKEN);

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: "upstream_unavailable" } });
    });
  });
});

function response_body(response: { json: <T>() => T }): Record<string, unknown> {
  return response.json<Record<string, unknown>>();
}
