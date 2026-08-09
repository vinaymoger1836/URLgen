/**
 * Rate limiting as a caller experiences it: statuses, headers, and the two
 * dimensions being genuinely independent.
 */

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import {
  InMemoryAbuseQueue,
  InMemoryAbuseRepository,
} from "../repositories/abuse-repository.js";
import { InMemoryLinkRepository } from "../repositories/in-memory-link-repository.js";
import {
  InMemoryRateLimiter,
  type RateLimitDecision,
  type RateLimiter,
} from "../repositories/rate-limiter.js";
import { buildServer } from "../server.js";
import type { SafeBrowsingVerdict, UrlSafetyChecker } from "../services/safe-browsing.js";

const permissive: UrlSafetyChecker = {
  check: (): Promise<SafeBrowsingVerdict> => Promise.resolve("safe"),
};

/** A limiter whose every call fails, standing in for Redis being unreachable. */
class BrokenRateLimiter implements RateLimiter {
  public calls = 0;

  public consume(): Promise<RateLimitDecision> {
    this.calls += 1;
    return Promise.reject(new Error("redis is down"));
  }
}

function build(rateLimiter: RateLimiter, env: Record<string, string> = {}): FastifyInstance {
  return buildServer(loadConfig({ NODE_ENV: "test", SHORT_DOMAIN: "urlgen.test", ...env }), {
    linkRepository: new InMemoryLinkRepository(),
    urlSafetyChecker: permissive,
    edgeCache: { put: () => Promise.resolve(), purge: () => Promise.resolve() },
    rateLimiter,
    abuseRepository: new InMemoryAbuseRepository(),
    abuseQueue: new InMemoryAbuseQueue(),
  });
}

let app: FastifyInstance;

function create(ownerId = "alice", url = "https://example.com/") {
  return app.inject({
    method: "POST",
    url: "/api/links",
    headers: { "x-owner-id": ownerId },
    /* A distinct URL per call, or dedup returns the first link and the request
       never reaches the parts under test. */
    payload: { url },
  });
}

afterEach(async () => {
  await app.close();
});

describe("rate limiting POST /api/links", () => {
  beforeEach(() => {
    app = build(new InMemoryRateLimiter(), {
      RATE_LIMIT_CREATE_PER_IP: "3",
      RATE_LIMIT_CREATE_PER_IP_WINDOW_SECONDS: "60",
    });
  });

  it("allows up to the limit, then answers 429 with the standard error envelope", async () => {
    for (let index = 0; index < 3; index += 1) {
      const response = await create("alice", `https://example.com/${String(index)}`);
      expect(response.statusCode).toBe(201);
    }

    const refused = await create("alice", "https://example.com/overflow");
    expect(refused.statusCode).toBe(429);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("rate_limited");
  });

  it("reports the budget on every allowed response", async () => {
    const first = await create("alice", "https://example.com/a");

    expect(first.headers["x-ratelimit-limit"]).toBe("3");
    expect(first.headers["x-ratelimit-remaining"]).toBe("2");
    expect(Number(first.headers["x-ratelimit-reset"])).toBeGreaterThan(Date.now() / 1000);
  });

  it("sends Retry-After on the rejection, in whole seconds and never zero", async () => {
    for (let index = 0; index < 3; index += 1) {
      await create("alice", `https://example.com/${String(index)}`);
    }

    const refused = await create("alice", "https://example.com/overflow");
    const retryAfter = Number(refused.headers["retry-after"]);

    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(refused.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("reports the tighter of the two dimensions, not the looser one", async () => {
    /* Per-IP is 3, per-owner is the default 100. A caller told it has 99 left
       immediately before being refused would have no way to behave correctly. */
    const response = await create("alice", "https://example.com/tight");
    expect(response.headers["x-ratelimit-limit"]).toBe("3");
  });
});

describe("the two dimensions are independent", () => {
  it("the per-IP limit is shared across owners", async () => {
    app = build(new InMemoryRateLimiter(), { RATE_LIMIT_CREATE_PER_IP: "2" });

    expect((await create("alice", "https://example.com/1")).statusCode).toBe(201);
    expect((await create("bob", "https://example.com/2")).statusCode).toBe(201);

    /* A third owner from the same address is still the same address. This is what
       stops "pick a new x-owner-id per request" from being a free bypass. */
    const third = await create("carol", "https://example.com/3");
    expect(third.statusCode).toBe(429);
    expect(third.json<{ error: { message: string } }>().error.message).toContain("create:ip");
  });

  it("the per-owner limit binds even when the IP budget is untouched", async () => {
    app = build(new InMemoryRateLimiter(), {
      RATE_LIMIT_CREATE_PER_IP: "1000",
      RATE_LIMIT_CREATE_PER_OWNER: "2",
    });

    expect((await create("alice", "https://example.com/1")).statusCode).toBe(201);
    expect((await create("alice", "https://example.com/2")).statusCode).toBe(201);

    const third = await create("alice", "https://example.com/3");
    expect(third.statusCode).toBe(429);
    expect(third.json<{ error: { message: string } }>().error.message).toContain("create:owner");

    /* A different owner from the same address still gets through, which is what
       makes this a per-owner limit rather than a second per-IP one. */
    expect((await create("bob", "https://example.com/4")).statusCode).toBe(201);
  });
});

describe("when the limiter itself is unavailable", () => {
  it("fails open rather than taking the write path down with Redis", async () => {
    const limiter = new BrokenRateLimiter();
    app = build(limiter);

    const response = await create("alice", "https://example.com/open");

    expect(response.statusCode).toBe(201);
    expect(limiter.calls).toBe(1);
    /* And it must not claim a budget it did not check — a header here would be a
       confident number describing a limit nobody enforced. */
    expect(response.headers["x-ratelimit-limit"]).toBeUndefined();
  });
});

describe("RATE_LIMIT_ENABLED=false", () => {
  it("installs a limiter that never refuses", async () => {
    app = buildServer(
      loadConfig({
        NODE_ENV: "test",
        SHORT_DOMAIN: "urlgen.test",
        RATE_LIMIT_ENABLED: "false",
        RATE_LIMIT_CREATE_PER_IP: "1",
      }),
      {
        linkRepository: new InMemoryLinkRepository(),
        urlSafetyChecker: permissive,
        edgeCache: { put: () => Promise.resolve(), purge: () => Promise.resolve() },
        /* No rateLimiter override: the point is what the server picks for itself. */
      },
    );

    for (let index = 0; index < 5; index += 1) {
      const response = await create("alice", `https://example.com/${String(index)}`);
      expect(response.statusCode).toBe(201);
    }
  });
});

describe("rate limiting the abuse endpoint", () => {
  it("refuses a flood of reports from one address", async () => {
    app = build(new InMemoryRateLimiter(), { RATE_LIMIT_REPORT_PER_IP: "2" });

    const report = () =>
      app.inject({
        method: "POST",
        url: "/api/abuse-reports",
        payload: { slug: "abc1234", reason: "phishing" },
      });

    expect((await report()).statusCode).toBe(202);
    expect((await report()).statusCode).toBe(202);
    expect((await report()).statusCode).toBe(429);
  });
});
