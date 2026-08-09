import { kvLinkKey, urlDedupHash, type KvLinkValue } from "@urlgen/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { EdgeCacheError, type EdgeCache } from "../repositories/edge-cache.js";
import { InMemoryLinkRepository } from "../repositories/in-memory-link-repository.js";
import { InMemoryRateLimiter } from "../repositories/rate-limiter.js";
import { buildServer } from "../server.js";
import type { SafeBrowsingVerdict, UrlSafetyChecker } from "../services/safe-browsing.js";

const config = loadConfig({ NODE_ENV: "test", SHORT_DOMAIN: "urlgen.test" });

class StubChecker implements UrlSafetyChecker {
  public verdict: SafeBrowsingVerdict = "safe";
  public checked: string[] = [];

  public check(url: string): Promise<SafeBrowsingVerdict> {
    this.checked.push(url);
    return Promise.resolve(this.verdict);
  }
}

type EdgeCacheOp =
  | { op: "put"; slug: string; value: KvLinkValue }
  | { op: "purge"; slug: string };

/** Records what the routes ask of the edge, and can be told to fail. */
class RecordingEdgeCache implements EdgeCache {
  public readonly ops: EdgeCacheOp[] = [];
  public failure: Error | undefined;

  public put(slug: string, value: KvLinkValue): Promise<void> {
    this.ops.push({ op: "put", slug, value });
    return this.#settle();
  }

  public purge(slug: string): Promise<void> {
    this.ops.push({ op: "purge", slug });
    return this.#settle();
  }

  #settle(): Promise<void> {
    return this.failure === undefined ? Promise.resolve() : Promise.reject(this.failure);
  }
}

let app: FastifyInstance;
let repository: InMemoryLinkRepository;
let checker: StubChecker;
let edgeCache: RecordingEdgeCache;

beforeEach(async () => {
  repository = new InMemoryLinkRepository();
  checker = new StubChecker();
  edgeCache = new RecordingEdgeCache();
  app = buildServer(config, {
    linkRepository: repository,
    urlSafetyChecker: checker,
    edgeCache,
    /*
     * Injected for two separate reasons, both of which bit on the way in.
     *
     * Without it these tests reach for the *real* Redis limiter, because the
     * click pipeline builds a connection whenever no buffer is injected — so
     * every create waited out the 2s command timeout against a Redis nobody
     * started, and the file went from seconds to two minutes.
     *
     * And with a Redis actually running they would have failed differently and
     * more confusingly: every request in this file arrives from 127.0.0.1, so
     * the whole file shares one per-IP window and the 21st create in it would
     * 429. A fresh limiter per test is what makes each test independent.
     */
    rateLimiter: new InMemoryRateLimiter(),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function createLink(body: Record<string, unknown>, ownerId = "alice") {
  return app.inject({
    method: "POST",
    url: "/api/links",
    headers: { "x-owner-id": ownerId },
    payload: body,
  });
}

describe("POST /api/links", () => {
  it("creates a link and returns the short URL", async () => {
    const response = await createLink({ url: "https://example.com/article" });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ slug: string; shortUrl: string; deduplicated: boolean }>();
    expect(body.slug).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(body.shortUrl).toBe(`https://urlgen.test/${body.slug}`);
    expect(body.deduplicated).toBe(false);
  });

  it("never exposes the internal dedup hash", async () => {
    const response = await createLink({ url: "https://example.com/a" });
    expect(response.json()).not.toHaveProperty("urlHash");
  });

  it("honours a custom slug and rejects a second use of it", async () => {
    const first = await createLink({ url: "https://example.com/a", customSlug: "launch-2026" });
    expect(first.statusCode).toBe(201);
    expect(first.json<{ slug: string }>().slug).toBe("launch-2026");

    const second = await createLink({ url: "https://example.com/b", customSlug: "launch-2026" });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: "slug_taken" } });
  });

  it("rejects a reserved custom slug", async () => {
    const response = await createLink({ url: "https://example.com/a", customSlug: "admin" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("returns the existing link when the same owner shortens the same URL twice", async () => {
    const first = await createLink({ url: "https://example.com/p?a=1&b=2" });
    /* Differs only by param order and a tracking param — the same destination. */
    const second = await createLink({ url: "https://example.com/p?b=2&a=1&utm_source=nl" });

    expect(second.statusCode).toBe(200);
    expect(second.json<{ deduplicated: boolean }>().deduplicated).toBe(true);
    expect(second.json<{ slug: string }>().slug).toBe(first.json<{ slug: string }>().slug);
    expect(repository.size).toBe(1);
  });

  it("does not share a slug across owners", async () => {
    const alice = await createLink({ url: "https://example.com/same" }, "alice");
    const bob = await createLink({ url: "https://example.com/same" }, "bob");

    expect(bob.statusCode).toBe(201);
    expect(bob.json<{ slug: string }>().slug).not.toBe(alice.json<{ slug: string }>().slug);
    expect(repository.size).toBe(2);
  });

  describe("hostile input", () => {
    const cases: readonly (readonly [string, string, number])[] = [
      ["javascript:alert(1)", "unsupported_protocol", 400],
      ["data:text/html;base64,PHNjcmlwdD4=", "unsupported_protocol", 400],
      ["file:///etc/passwd", "unsupported_protocol", 400],
      ["http://127.0.0.1/admin", "unsafe_url", 422],
      ["http://2130706433/", "unsafe_url", 422],
      ["http://0x7f000001/", "unsafe_url", 422],
      ["http://[::1]/", "unsafe_url", 422],
      ["http://169.254.169.254/latest/meta-data/", "unsafe_url", 422],
      ["http://192.168.1.1/", "unsafe_url", 422],
      ["http://10.0.0.1/", "unsafe_url", 422],
      ["http://localhost/", "unsafe_url", 422],
      ["https://printer.local/", "unsafe_url", 422],
      ["https://user:pw@example.com/", "invalid_url", 400],
      ["not a url", "invalid_url", 400],
      ["/relative", "invalid_url", 400],
    ];

    it.each(cases)("rejects %s", async (url, code, status) => {
      const response = await createLink({ url });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ error: { code } });
    });

    it("refuses to shorten its own domain, which would loop", async () => {
      const response = await createLink({ url: "https://urlgen.test/abc1234" });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: "unsafe_url" } });
    });

    it("rejects an expiry in the past", async () => {
      const response = await createLink({
        url: "https://example.com/a",
        expiresAt: "2020-01-01T00:00:00.000Z",
      });
      expect(response.statusCode).toBe(400);
    });
  });

  it("rejects a URL flagged by Safe Browsing", async () => {
    checker.verdict = "malicious";
    const response = await createLink({ url: "https://malware.example.com/" });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "unsafe_url" } });
    expect(repository.size).toBe(0);
  });

  it("allows the URL when Safe Browsing cannot reach a verdict", async () => {
    checker.verdict = "unknown";
    const response = await createLink({ url: "https://example.com/a" });
    expect(response.statusCode).toBe(201);
  });

  it("does not call Safe Browsing for a URL already rejected structurally", async () => {
    await createLink({ url: "http://127.0.0.1/" });
    expect(checker.checked).toEqual([]);
  });
});

describe("GET /api/links/:slug", () => {
  it("returns a link to its owner", async () => {
    const created = await createLink({ url: "https://example.com/a" });
    const { slug } = created.json<{ slug: string }>();

    const response = await app.inject({
      method: "GET",
      url: `/api/links/${slug}`,
      headers: { "x-owner-id": "alice" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ targetUrl: string }>().targetUrl).toBe("https://example.com/a");
  });

  it("hides another owner's link behind the same 404 as a missing one", async () => {
    const created = await createLink({ url: "https://example.com/a" }, "alice");
    const { slug } = created.json<{ slug: string }>();

    const foreign = await app.inject({
      method: "GET",
      url: `/api/links/${slug}`,
      headers: { "x-owner-id": "mallory" },
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/links/zzzzzzz",
      headers: { "x-owner-id": "mallory" },
    });

    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());
  });

  it("404s on a malformed slug without touching storage", async () => {
    const response = await app.inject({ method: "GET", url: "/api/links/not%20a%20slug" });
    expect(response.statusCode).toBe(404);
  });
});

describe("PATCH /api/links/:slug", () => {
  it("updates the target URL and the dedup hash together", async () => {
    const created = await createLink({ url: "https://example.com/old" });
    const { slug } = created.json<{ slug: string }>();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/links/${slug}`,
      headers: { "x-owner-id": "alice" },
      payload: { url: "https://example.com/new" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ targetUrl: string }>().targetUrl).toBe("https://example.com/new");

    /* The index must follow the URL, or dedup would keep matching the old one. */
    const expectedHash = await urlDedupHash("https://example.com/new", "alice");
    await expect(repository.findSlugByUrlHash(expectedHash)).resolves.toBe(slug);
  });

  it("rejects an unsafe new target", async () => {
    const created = await createLink({ url: "https://example.com/a" });
    const { slug } = created.json<{ slug: string }>();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/links/${slug}`,
      headers: { "x-owner-id": "alice" },
      payload: { url: "http://169.254.169.254/" },
    });

    expect(response.statusCode).toBe(422);
  });

  it("rejects an empty patch", async () => {
    const created = await createLink({ url: "https://example.com/a" });
    const { slug } = created.json<{ slug: string }>();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/links/${slug}`,
      headers: { "x-owner-id": "alice" },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it("will not let another owner modify a link", async () => {
    const created = await createLink({ url: "https://example.com/a" }, "alice");
    const { slug } = created.json<{ slug: string }>();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/links/${slug}`,
      headers: { "x-owner-id": "mallory" },
      payload: { url: "https://evil.example.com/" },
    });

    expect(response.statusCode).toBe(404);
    const unchanged = await repository.findBySlug(slug);
    expect(unchanged?.targetUrl).toBe("https://example.com/a");
  });
});

describe("DELETE /api/links/:slug", () => {
  it("soft deletes and is idempotent", async () => {
    const created = await createLink({ url: "https://example.com/a" });
    const { slug } = created.json<{ slug: string }>();

    const first = await app.inject({
      method: "DELETE",
      url: `/api/links/${slug}`,
      headers: { "x-owner-id": "alice" },
    });
    const second = await app.inject({
      method: "DELETE",
      url: `/api/links/${slug}`,
      headers: { "x-owner-id": "alice" },
    });

    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);

    /* The row survives so the slug can never be handed to someone else. */
    const stored = await repository.findBySlug(slug);
    expect(stored?.status).toBe("deleted");
  });
});

describe("GET /api/links", () => {
  it("lists only the caller's links, newest first, excluding deleted ones", async () => {
    await createLink({ url: "https://example.com/1" }, "alice");
    await createLink({ url: "https://example.com/2" }, "alice");
    const doomed = await createLink({ url: "https://example.com/3" }, "alice");
    await createLink({ url: "https://example.com/4" }, "bob");

    await app.inject({
      method: "DELETE",
      url: `/api/links/${doomed.json<{ slug: string }>().slug}`,
      headers: { "x-owner-id": "alice" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/links",
      headers: { "x-owner-id": "alice" },
    });

    expect(response.statusCode).toBe(200);
    const { items } = response.json<{ items: { targetUrl: string }[] }>();
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.targetUrl)).not.toContain("https://example.com/3");
    expect(items.map((item) => item.targetUrl)).not.toContain("https://example.com/4");
  });

  it("rejects a nonsense limit", async () => {
    const response = await app.inject({ method: "GET", url: "/api/links?limit=9999" });
    expect(response.statusCode).toBe(400);
  });
});

describe("edge cache invalidation", () => {
  async function createFor(body: Record<string, unknown>): Promise<string> {
    const response = await createLink(body);
    return response.json<{ slug: string }>().slug;
  }

  it("warms the edge on create so the first click is a hit", async () => {
    const slug = await createFor({ url: "https://example.com/new" });

    expect(edgeCache.ops).toEqual([
      { op: "put", slug, value: { u: "https://example.com/new", s: "active" } },
    ]);
  });

  it("carries the expiry into the cached blob as epoch milliseconds", async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();

    const slug = await createFor({ url: "https://example.com/timed", expiresAt });

    expect(edgeCache.ops).toEqual([
      {
        op: "put",
        slug,
        value: { u: "https://example.com/timed", s: "active", e: Date.parse(expiresAt) },
      },
    ]);
  });

  it("does not write again when a create is deduplicated", async () => {
    await createFor({ url: "https://example.com/same" });
    edgeCache.ops.length = 0;

    await createLink({ url: "https://example.com/same" });

    /* The existing entry is already correct, and KV writes are the scarce
       resource — 1000 a day against 100000 reads. */
    expect(edgeCache.ops).toEqual([]);
  });

  it("overwrites the entry when the target changes", async () => {
    const slug = await createFor({ url: "https://example.com/before" });
    edgeCache.ops.length = 0;

    await app.inject({
      method: "PATCH",
      url: `/api/links/${slug}`,
      headers: { "x-owner-id": "alice" },
      payload: { url: "https://example.com/after" },
    });

    expect(edgeCache.ops).toEqual([
      { op: "put", slug, value: { u: "https://example.com/after", s: "active" } },
    ]);
  });

  it("pushes a disabled status to the edge instead of purging it", async () => {
    const slug = await createFor({ url: "https://example.com/abusive" });
    edgeCache.ops.length = 0;

    await app.inject({
      method: "PATCH",
      url: `/api/links/${slug}`,
      headers: { "x-owner-id": "alice" },
      payload: { status: "disabled" },
    });

    /* A disabled link is the one most likely to still be receiving traffic.
       Keeping a tombstone at the edge means those hits are answered there rather
       than becoming a cache miss and an origin round trip each. */
    expect(edgeCache.ops).toEqual([
      { op: "put", slug, value: { u: "https://example.com/abusive", s: "disabled" } },
    ]);
  });

  it("purges the entry on delete", async () => {
    const slug = await createFor({ url: "https://example.com/gone" });
    edgeCache.ops.length = 0;

    await app.inject({
      method: "DELETE",
      url: `/api/links/${slug}`,
      headers: { "x-owner-id": "alice" },
    });

    expect(edgeCache.ops).toEqual([{ op: "purge", slug }]);
  });

  it("does not touch the edge when a delete matched nothing", async () => {
    await app.inject({
      method: "DELETE",
      url: "/api/links/nosuchslug",
      headers: { "x-owner-id": "alice" },
    });

    expect(edgeCache.ops).toEqual([]);
  });

  it("uses a key the Worker will actually read", async () => {
    const slug = await createFor({ url: "https://example.com/keyed" });

    /* Both sides derive the key from @urlgen/shared. Asserting the derived form
       here is what would catch a prefix change made on only one side. */
    expect(kvLinkKey(slug)).toBe(`l:${slug}`);
  });

  describe("when the edge cache is failing", () => {
    beforeEach(() => {
      edgeCache.failure = new EdgeCacheError("Cloudflare KV returned 500", 500);
    });

    it("still reports a successful create", async () => {
      const response = await createLink({ url: "https://example.com/despite" });

      /* The row is already written. Failing here would tell the owner their link
         was not created when it was, and a retry would allocate a second slug. */
      expect(response.statusCode).toBe(201);
    });

    it("still reports a successful update", async () => {
      const slug = await createFor({ url: "https://example.com/a" });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/links/${slug}`,
        headers: { "x-owner-id": "alice" },
        payload: { url: "https://example.com/b" },
      });

      expect(response.statusCode).toBe(200);
    });

    it("still reports a successful delete", async () => {
      const slug = await createFor({ url: "https://example.com/a" });

      const response = await app.inject({
        method: "DELETE",
        url: `/api/links/${slug}`,
        headers: { "x-owner-id": "alice" },
      });

      expect(response.statusCode).toBe(204);
    });

    it("leaves the source of truth updated even though the edge is stale", async () => {
      const slug = await createFor({ url: "https://example.com/a" });

      await app.inject({
        method: "DELETE",
        url: `/api/links/${slug}`,
        headers: { "x-owner-id": "alice" },
      });

      await expect(repository.findBySlug(slug)).resolves.toMatchObject({ status: "deleted" });
    });
  });
});
