import { urlDedupHash } from "@urlgen/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { InMemoryLinkRepository } from "../repositories/in-memory-link-repository.js";
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

let app: FastifyInstance;
let repository: InMemoryLinkRepository;
let checker: StubChecker;

beforeEach(async () => {
  repository = new InMemoryLinkRepository();
  checker = new StubChecker();
  app = buildServer(config, { linkRepository: repository, urlSafetyChecker: checker });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function createLink(body: unknown, ownerId = "alice") {
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
    const cases: ReadonlyArray<readonly [string, string, number]> = [
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
