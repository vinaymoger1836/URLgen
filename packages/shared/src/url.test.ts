import { describe, expect, it } from "vitest";

import { canonicalizeUrl, isTrackingParam, parseUrl } from "./url.js";

describe("parseUrl", () => {
  it("returns a URL for valid absolute input", () => {
    expect(parseUrl("https://example.com/a")?.hostname).toBe("example.com");
  });

  it("returns undefined instead of throwing", () => {
    expect(parseUrl("not a url")).toBeUndefined();
    expect(parseUrl("/relative/path")).toBeUndefined();
    expect(parseUrl("")).toBeUndefined();
  });
});

describe("isTrackingParam", () => {
  it("matches known campaign parameters case-insensitively", () => {
    expect(isTrackingParam("utm_source")).toBe(true);
    expect(isTrackingParam("UTM_Source")).toBe(true);
    expect(isTrackingParam("fbclid")).toBe(true);
  });

  it("does not match ordinary parameters", () => {
    expect(isTrackingParam("id")).toBe(false);
    expect(isTrackingParam("q")).toBe(false);
    expect(isTrackingParam("utmsource")).toBe(false);
  });
});

describe("canonicalizeUrl", () => {
  it("lowercases scheme and host but preserves path case", () => {
    expect(canonicalizeUrl("HTTPS://Example.COM/MyPath")).toBe("https://example.com/MyPath");
  });

  it("drops the fragment", () => {
    expect(canonicalizeUrl("https://example.com/a#section-2")).toBe("https://example.com/a");
  });

  it("strips embedded credentials", () => {
    expect(canonicalizeUrl("https://user:secret@example.com/a")).toBe("https://example.com/a");
  });

  it("removes default ports but keeps non-default ones", () => {
    expect(canonicalizeUrl("https://example.com:443/a")).toBe("https://example.com/a");
    expect(canonicalizeUrl("http://example.com:80/a")).toBe("http://example.com/a");
    expect(canonicalizeUrl("https://example.com:8443/a")).toBe("https://example.com:8443/a");
  });

  it("removes tracking parameters", () => {
    expect(canonicalizeUrl("https://example.com/p?utm_source=nl&utm_medium=email&id=7")).toBe(
      "https://example.com/p?id=7",
    );
  });

  it("drops the query string entirely when only tracking params were present", () => {
    expect(canonicalizeUrl("https://example.com/p?utm_source=nl")).toBe("https://example.com/p");
  });

  it("sorts query parameters so order does not create a duplicate link", () => {
    const a = canonicalizeUrl("https://example.com/p?b=2&a=1");
    const b = canonicalizeUrl("https://example.com/p?a=1&b=2");
    expect(a).toBe(b);
    expect(a).toBe("https://example.com/p?a=1&b=2");
  });

  it("sorts repeated keys by value deterministically", () => {
    expect(canonicalizeUrl("https://example.com/p?tag=z&tag=a")).toBe(
      "https://example.com/p?tag=a&tag=z",
    );
  });

  it("adds the root slash so bare hosts collapse together", () => {
    expect(canonicalizeUrl("https://example.com")).toBe("https://example.com/");
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("keeps www and trailing slashes on sub-paths, which can address different resources", () => {
    expect(canonicalizeUrl("https://www.example.com/a")).not.toBe(
      canonicalizeUrl("https://example.com/a"),
    );
    expect(canonicalizeUrl("https://example.com/a/")).not.toBe(
      canonicalizeUrl("https://example.com/a"),
    );
  });

  it("trims surrounding whitespace", () => {
    expect(canonicalizeUrl("  https://example.com/a  ")).toBe("https://example.com/a");
  });

  it("throws on input that is not an absolute URL", () => {
    expect(() => canonicalizeUrl("nonsense")).toThrow(TypeError);
  });
});
