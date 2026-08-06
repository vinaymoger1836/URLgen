import { describe, expect, it } from "vitest";

import {
  createLinkRequestSchema,
  kvBackstopTtlSeconds,
  kvLinkKey,
  kvLinkValueSchema,
  targetUrlSchema,
  type KvLinkValue,
} from "./schemas.js";

function messagesFor(input: unknown): string[] {
  const result = createLinkRequestSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("targetUrlSchema", () => {
  it("accepts ordinary http and https URLs", () => {
    expect(targetUrlSchema.safeParse("https://example.com/a").success).toBe(true);
    expect(targetUrlSchema.safeParse("http://example.com").success).toBe(true);
  });

  it("trims before validating", () => {
    expect(targetUrlSchema.parse("  https://example.com/a  ")).toBe("https://example.com/a");
  });

  it("rejects script-bearing and non-web schemes", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
      "ftp://example.com/f",
    ]) {
      expect(targetUrlSchema.safeParse(hostile).success).toBe(false);
    }
  });

  it("rejects embedded credentials", () => {
    expect(targetUrlSchema.safeParse("https://user:pass@example.com").success).toBe(false);
  });

  it("rejects relative and malformed input", () => {
    expect(targetUrlSchema.safeParse("/just/a/path").success).toBe(false);
    expect(targetUrlSchema.safeParse("example.com").success).toBe(false);
    expect(targetUrlSchema.safeParse("").success).toBe(false);
  });

  it("rejects URLs longer than the 2048 character limit", () => {
    const tooLong = `https://example.com/${"a".repeat(2048)}`;
    expect(targetUrlSchema.safeParse(tooLong).success).toBe(false);
  });
});

describe("createLinkRequestSchema", () => {
  it("accepts a minimal request", () => {
    const parsed = createLinkRequestSchema.parse({ url: "https://example.com/a" });
    expect(parsed).toEqual({ url: "https://example.com/a" });
  });

  it("accepts a full request", () => {
    const parsed = createLinkRequestSchema.parse({
      url: "https://example.com/a",
      customSlug: "launch-2026",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(parsed.customSlug).toBe("launch-2026");
  });

  it("rejects a reserved custom slug with a readable message", () => {
    expect(messagesFor({ url: "https://example.com", customSlug: "admin" })).toContain(
      "slug is reserved by the platform",
    );
  });

  it("rejects a malformed custom slug", () => {
    expect(messagesFor({ url: "https://example.com", customSlug: "no spaces" })).toContain(
      "slug may only contain letters, digits, hyphen and underscore",
    );
  });

  it("rejects a non-timestamp expiry", () => {
    expect(messagesFor({ url: "https://example.com", expiresAt: "next tuesday" })).toContain(
      "must be an ISO-8601 timestamp",
    );
  });

  it("rejects a missing url", () => {
    expect(createLinkRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("kvLinkValueSchema", () => {
  it("parses the compact edge payload", () => {
    expect(kvLinkValueSchema.parse({ u: "https://example.com/a", s: "active" })).toEqual({
      u: "https://example.com/a",
      s: "active",
    });
    expect(
      kvLinkValueSchema.parse({ u: "https://example.com/a", s: "active", e: 1893456000000 }).e,
    ).toBe(1893456000000);
  });

  it("rejects an unknown status or a non-positive expiry", () => {
    expect(kvLinkValueSchema.safeParse({ u: "https://e.com", s: "removed" }).success).toBe(false);
    expect(kvLinkValueSchema.safeParse({ u: "https://e.com", s: "active", e: 0 }).success).toBe(
      false,
    );
  });
});

describe("kvLinkKey", () => {
  it("namespaces the slug so other key families can share the namespace", () => {
    expect(kvLinkKey("abc1234")).toBe("l:abc1234");
  });
});

describe("kvBackstopTtlSeconds", () => {
  const NOW = Date.parse("2026-08-06T12:00:00.000Z");
  const WEEK = 7 * 24 * 60 * 60;

  function value(overrides: Partial<KvLinkValue> = {}): KvLinkValue {
    return { u: "https://example.com/", s: "active", ...overrides };
  }

  it("gives a never-expiring link the full backstop", () => {
    expect(kvBackstopTtlSeconds(value(), NOW)).toBe(WEEK);
  });

  it("shortens the TTL to the link's own expiry when that comes first", () => {
    expect(kvBackstopTtlSeconds(value({ e: NOW + 3_600_000 }), NOW)).toBe(3600);
  });

  it("keeps the backstop when the expiry is further out than a week", () => {
    expect(kvBackstopTtlSeconds(value({ e: NOW + 30 * 86_400_000 }), NOW)).toBe(WEEK);
  });

  it("declines to cache a link expiring inside KV's 60s floor", () => {
    /* KV rejects an expirationTtl under 60 seconds, and spending one of the day's
       1000 writes on an entry about to be wrong is worse than letting it miss. */
    expect(kvBackstopTtlSeconds(value({ e: NOW + 59_000 }), NOW)).toBeUndefined();
  });

  it("accepts an expiry exactly at the floor", () => {
    expect(kvBackstopTtlSeconds(value({ e: NOW + 60_000 }), NOW)).toBe(60);
  });

  it("declines to cache an already-expired link", () => {
    expect(kvBackstopTtlSeconds(value({ e: NOW - 1 }), NOW)).toBeUndefined();
  });
});
