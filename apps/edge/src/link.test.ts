import type { KvLinkValue } from "@urlgen/shared";
import { describe, expect, it } from "vitest";

import { evaluateLink } from "./link.js";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");

function blob(overrides: Partial<KvLinkValue> = {}): KvLinkValue {
  return { u: "https://example.com/page", s: "active", ...overrides };
}

describe("evaluateLink", () => {
  it("redirects an active link with no expiry", () => {
    expect(evaluateLink(blob(), NOW)).toEqual({
      kind: "redirect",
      targetUrl: "https://example.com/page",
    });
  });

  it("redirects an active link whose expiry is still in the future", () => {
    expect(evaluateLink(blob({ e: NOW + 1000 }), NOW)).toEqual({
      kind: "redirect",
      targetUrl: "https://example.com/page",
    });
  });

  it("treats an elapsed expiry as gone even though the status still says active", () => {
    /* This is the case DynamoDB's TTL sweeper cannot cover: AWS only promises
       deletion within about 48 hours, so the status attribute lags reality. */
    expect(evaluateLink(blob({ e: NOW - 1 }), NOW)).toEqual({ kind: "gone", reason: "expired" });
  });

  it("treats an expiry exactly at the current instant as elapsed", () => {
    expect(evaluateLink(blob({ e: NOW }), NOW)).toEqual({ kind: "gone", reason: "expired" });
  });

  it("reports a disabled link as gone", () => {
    expect(evaluateLink(blob({ s: "disabled" }), NOW)).toEqual({
      kind: "gone",
      reason: "disabled",
    });
  });

  it("reports an expired status as gone even with no expiry timestamp", () => {
    expect(evaluateLink(blob({ s: "expired" }), NOW)).toEqual({ kind: "gone", reason: "expired" });
  });

  it("reports a deleted link as missing, not gone", () => {
    /* A visitor must not be able to tell "this was deleted" from "this never
       existed" — otherwise the 404/410 split enumerates which slugs are real. */
    expect(evaluateLink(blob({ s: "deleted" }), NOW)).toEqual({ kind: "missing" });
  });

  describe("open-redirect guard", () => {
    it.each([
      ["javascript:alert(1)", "target protocol is not http(s)"],
      ["data:text/html,<script>alert(1)</script>", "target protocol is not http(s)"],
      ["ftp://example.com/file", "target protocol is not http(s)"],
      ["/relative/path", "target is not a parseable URL"],
      ["", "target is not a parseable URL"],
    ])("refuses to emit %s as a Location", (target, detail) => {
      expect(evaluateLink(blob({ u: target }), NOW)).toEqual({ kind: "corrupt", detail });
    });

    it("still allows plain http, which is unlovely but not an escalation", () => {
      expect(evaluateLink(blob({ u: "http://example.com/" }), NOW)).toEqual({
        kind: "redirect",
        targetUrl: "http://example.com/",
      });
    });
  });
});
