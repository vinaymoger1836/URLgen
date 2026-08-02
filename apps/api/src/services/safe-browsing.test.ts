import { describe, expect, it, vi } from "vitest";

import { SafeBrowsingClient } from "./safe-browsing.js";

const API_KEY = "test-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A mock that builds a FRESH Response per call.
 *
 * `mockResolvedValue(new Response(...))` hands the same object to every call, and a
 * Response body is a single-use stream — the second `.json()` throws, which the
 * client swallows as a fail-open `unknown`. That silently turns cache assertions
 * into nonsense, so responses are always constructed per invocation.
 */
function respondWith(body: unknown, status = 200) {
  return vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
}

describe("SafeBrowsingClient", () => {
  it("is disabled and makes no network call without an API key", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = new SafeBrowsingClient({ fetchFn });

    expect(client.enabled).toBe(false);
    await expect(client.check("https://example.com/")).resolves.toBe("unknown");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports a clean URL as safe", async () => {
    const fetchFn = respondWith({});
    const client = new SafeBrowsingClient({ apiKey: API_KEY, fetchFn });

    await expect(client.check("https://example.com/")).resolves.toBe("safe");
  });

  it("reports a threat match as malicious", async () => {
    const fetchFn = respondWith({ matches: [{ threatType: "MALWARE" }] });
    const client = new SafeBrowsingClient({ apiKey: API_KEY, fetchFn });

    await expect(client.check("https://malware.example/")).resolves.toBe("malicious");
  });

  it("treats an empty matches array as safe", async () => {
    const fetchFn = respondWith({ matches: [] });
    const client = new SafeBrowsingClient({ apiKey: API_KEY, fetchFn });

    await expect(client.check("https://example.com/")).resolves.toBe("safe");
  });

  it("sends the URL in the documented request shape", async () => {
    const fetchFn = respondWith({});
    const client = new SafeBrowsingClient({ apiKey: API_KEY, fetchFn });

    await client.check("https://example.com/path");

    const [, init] = fetchFn.mock.calls[0] ?? [];
    const sent = init?.body;
    expect(typeof sent).toBe("string");
    const body: unknown = JSON.parse(typeof sent === "string" ? sent : "{}");
    expect(body).toMatchObject({
      threatInfo: { threatEntries: [{ url: "https://example.com/path" }] },
    });
  });

  describe("fail-open behaviour", () => {
    it("returns unknown on a non-200 rather than blocking the create", async () => {
      const fetchFn = respondWith({}, 429);
      const client = new SafeBrowsingClient({ apiKey: API_KEY, fetchFn });

      await expect(client.check("https://example.com/")).resolves.toBe("unknown");
    });

    it("returns unknown when the network call throws", async () => {
      const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNRESET"));
      const client = new SafeBrowsingClient({ apiKey: API_KEY, fetchFn });

      await expect(client.check("https://example.com/")).resolves.toBe("unknown");
    });

    it("returns unknown when the body is not valid JSON", async () => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockImplementation(() => Promise.resolve(new Response("<html>oops</html>")));
      const client = new SafeBrowsingClient({ apiKey: API_KEY, fetchFn });

      await expect(client.check("https://example.com/")).resolves.toBe("unknown");
    });

    it("reports the failure so it can be logged, without throwing", async () => {
      const onError = vi.fn();
      const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("boom"));
      const client = new SafeBrowsingClient({ apiKey: API_KEY, fetchFn, onError });

      await client.check("https://example.com/");

      expect(onError).toHaveBeenCalledOnce();
    });
  });

  describe("caching", () => {
    it("looks a URL up once and reuses the verdict", async () => {
      const fetchFn = respondWith({});
      const client = new SafeBrowsingClient({ apiKey: API_KEY, fetchFn });

      await client.check("https://example.com/");
      await client.check("https://example.com/");
      await client.check("https://example.com/");

      expect(fetchFn).toHaveBeenCalledOnce();
    });

    it("does not cache a failure, so a transient outage is retried", async () => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockImplementation(() => Promise.resolve(jsonResponse({})));
      const client = new SafeBrowsingClient({ apiKey: API_KEY, fetchFn });

      await expect(client.check("https://example.com/")).resolves.toBe("unknown");
      await expect(client.check("https://example.com/")).resolves.toBe("safe");
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("expires a cached verdict after its TTL", async () => {
      vi.useFakeTimers();
      try {
        const fetchFn = respondWith({});
        const client = new SafeBrowsingClient({ apiKey: API_KEY, fetchFn, cacheTtlMs: 1000 });

        await client.check("https://example.com/");
        vi.advanceTimersByTime(1500);
        await client.check("https://example.com/");

        expect(fetchFn).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("bounds the cache so a long-lived process cannot grow without limit", async () => {
      const fetchFn = respondWith({});
      const client = new SafeBrowsingClient({ apiKey: API_KEY, fetchFn, maxCacheEntries: 2 });

      await client.check("https://a.example/");
      await client.check("https://b.example/");
      await client.check("https://c.example/"); // evicts a
      await client.check("https://a.example/"); // must be a fresh lookup

      expect(fetchFn).toHaveBeenCalledTimes(4);
    });
  });
});
