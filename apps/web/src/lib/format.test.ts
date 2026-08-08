import { describe, expect, it } from "vitest";

import {
  formatBreakdownKey,
  formatBucket,
  formatCount,
  formatInstant,
  formatShare,
} from "./format.js";

describe("formatCount", () => {
  it("shows small numbers in full", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1_284)).toBe("1,284");
    expect(formatCount(9_999)).toBe("9,999");
  });

  it("compacts thousands and millions", () => {
    expect(formatCount(12_900)).toBe("12.9K");
    expect(formatCount(4_200_000)).toBe("4.2M");
  });

  it("drops a trailing zero rather than printing 12.0K", () => {
    expect(formatCount(12_000)).toBe("12K");
    expect(formatCount(3_000_000)).toBe("3M");
  });
});

describe("formatShare", () => {
  it("rounds to a whole percent", () => {
    expect(formatShare(1, 3)).toBe("33%");
    expect(formatShare(2, 3)).toBe("67%");
  });

  it("reads as 0% rather than NaN when the panel is empty", () => {
    /* An empty panel divides by zero. "NaN%" in a dashboard is the kind of thing
       that gets screenshotted. */
    expect(formatShare(0, 0)).toBe("0%");
  });
});

describe("formatBucket", () => {
  it("labels hour buckets as a time", () => {
    expect(formatBucket("2026-08-08T14:00:00.000Z", "hour", "UTC")).toBe("14:00");
  });

  it("labels in the window's zone, not the machine's", () => {
    /* The server bucketed in this zone; an axis in a different one would disagree
       with its own data. 14:00 UTC is 19:30 in Kolkata. */
    expect(formatBucket("2026-08-08T14:00:00.000Z", "hour", "Asia/Kolkata")).toBe("19:30");
  });

  it("labels day buckets as a date", () => {
    expect(formatBucket("2026-08-08T00:00:00.000Z", "day", "UTC")).toBe("8 Aug");
  });

  it("puts a day bucket on the right calendar day for its zone", () => {
    /* The instant is 18:30 UTC on the 7th, which is midnight on the 8th in Kolkata —
       that is exactly what a day bucket for that zone looks like. */
    expect(formatBucket("2026-08-07T18:30:00.000Z", "day", "Asia/Kolkata")).toBe("8 Aug");
  });
});

describe("formatInstant", () => {
  it("is unambiguous about which bucket", () => {
    expect(formatInstant("2026-08-08T14:00:00.000Z", "UTC")).toBe("8 Aug, 14:00");
  });
});

describe("formatBreakdownKey", () => {
  it("names an empty referrer as direct traffic", () => {
    /* An empty referrer_host is real data — someone typed or pasted the link — and
       the API returns it verbatim rather than deciding what it means. */
    expect(formatBreakdownKey("referrer", "")).toBe("Direct");
  });

  it("names an empty value in any other dimension as unknown", () => {
    expect(formatBreakdownKey("country", "")).toBe("Unknown");
    expect(formatBreakdownKey("browser", "")).toBe("Unknown");
  });

  it("treats Cloudflare's XX placeholder as unknown", () => {
    expect(formatBreakdownKey("country", "XX")).toBe("Unknown");
  });

  it("expands a country code", () => {
    expect(formatBreakdownKey("country", "IN")).toBe("India");
    expect(formatBreakdownKey("country", "US")).toBe("United States");
  });

  it("falls back to the code it was given rather than throwing", () => {
    expect(formatBreakdownKey("country", "ZZZ")).toBe("ZZZ");
  });

  it("capitalizes a device type", () => {
    expect(formatBreakdownKey("deviceType", "mobile")).toBe("Mobile");
    expect(formatBreakdownKey("deviceType", "bot")).toBe("Bot");
  });

  it("leaves a host alone", () => {
    expect(formatBreakdownKey("referrer", "news.ycombinator.com")).toBe("news.ycombinator.com");
  });
});
