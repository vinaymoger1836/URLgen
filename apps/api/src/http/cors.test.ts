import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { InMemoryLinkRepository } from "../repositories/in-memory-link-repository.js";
import { buildServer } from "../server.js";

const ALLOWED = "https://dash.urlgen.test";
const OTHER = "https://evil.example";

const config = loadConfig({
  NODE_ENV: "test",
  CORS_ORIGINS: `${ALLOWED},http://localhost:3000`,
  INTERNAL_API_TOKEN: "t".repeat(40),
});

let app: FastifyInstance;

beforeEach(async () => {
  app = buildServer(config, { linkRepository: new InMemoryLinkRepository() });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function request(url: string, origin: string | undefined, method = "GET") {
  return app.inject({
    method: method as "GET",
    url,
    ...(origin !== undefined ? { headers: { origin } } : {}),
  });
}

describe("CORS", () => {
  it("echoes an allowed origin", async () => {
    const response = await request("/api/links", ALLOWED);
    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED);
  });

  it("allows every configured origin, not just the first", async () => {
    const response = await request("/api/links", "http://localhost:3000");
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("does not echo an origin that is not on the list", async () => {
    const response = await request("/api/links", OTHER);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    /* The request itself still runs — CORS is enforced by the browser refusing to
       hand the response to the page, not by the server refusing to answer. */
    expect(response.statusCode).toBe(200);
  });

  it("never answers with a wildcard", async () => {
    const response = await request("/api/links", ALLOWED);
    expect(response.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("always varies on Origin, allowed or not", async () => {
    /* Without this a shared cache can hand one origin's allow-header to another. */
    for (const origin of [ALLOWED, OTHER]) {
      const response = await request("/api/links", origin);
      expect(response.headers.vary).toContain("Origin");
    }
  });

  it("never grants credentials", async () => {
    const response = await request("/api/links", ALLOWED);
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("CORS preflight", () => {
  it("answers a preflight for a route that has no OPTIONS handler", async () => {
    /* `DELETE /api/links/:slug` is preflighted as OPTIONS. No route declares it, so
       without this the browser would see a 404 and call the method disallowed. */
    const response = await request("/api/links/abc1234", ALLOWED, "OPTIONS");

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(response.headers["access-control-allow-methods"]).toContain("DELETE");
    expect(response.headers["access-control-allow-headers"]).toContain("x-owner-id");
  });

  it("answers a rejected origin's preflight without the allow header", async () => {
    const response = await request("/api/links", OTHER, "OPTIONS");
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("CORS scope", () => {
  it("does not expose the worker's internal endpoints to a page", async () => {
    /* These carry a shared token. An endpoint that answers preflights is one that
       someone eventually calls from a browser. */
    const response = await request("/internal/resolve/abc1234", ALLOWED);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not expose the click ingest endpoint either", async () => {
    const response = await request("/ingest/click", ALLOWED, "OPTIONS");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    /* Not short-circuited as a preflight either — it falls through to routing. */
    expect(response.statusCode).toBe(404);
  });

  it("does not expose /health", async () => {
    const response = await request("/health", ALLOWED);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("is not fooled by a query string that starts with the api prefix", async () => {
    const response = await request("/health?next=/api/links", ALLOWED);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("CORS_ORIGINS validation", () => {
  it("rejects an entry with a path, which could never match the header", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "test", CORS_ORIGINS: "https://dash.urlgen.test/app" }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it("rejects a bare hostname", () => {
    expect(() => loadConfig({ NODE_ENV: "test", CORS_ORIGINS: "dash.urlgen.test" })).toThrow(
      /CORS_ORIGINS/,
    );
  });

  it("rejects a wildcard", () => {
    expect(() => loadConfig({ NODE_ENV: "test", CORS_ORIGINS: "*" })).toThrow(/CORS_ORIGINS/);
  });

  it("accepts a trailing slash, which is how a browser prints an origin", () => {
    const parsed = loadConfig({ NODE_ENV: "test", CORS_ORIGINS: "https://dash.urlgen.test/" });
    expect(parsed.CORS_ORIGINS).toEqual(["https://dash.urlgen.test"]);
  });
});
