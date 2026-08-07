import { describe, expect, it } from "vitest";

import type { ClickRow } from "../analytics/click-row.js";
import { clickBatchToken, toClickHouseDateTime } from "./clickhouse.js";

function row(id: string): ClickRow {
  return {
    eventId: id,
    slug: "abc1234",
    ts: Date.parse("2026-08-07T10:00:00.000Z"),
    country: "IN",
    city: "Bengaluru",
    timezone: "Asia/Kolkata",
    colo: "BOM",
    deviceType: "mobile",
    browser: "Safari",
    os: "iOS",
    referrerHost: "news.ycombinator.com",
    visitorHash: "0123456789abcdef0123456789abcdef",
  };
}

describe("clickBatchToken", () => {
  it("is identical for the same rows in the same order", () => {
    /* The retry path depends on this and nothing else: a batch replayed after a
       lost insert response must produce the token ClickHouse already saw. */
    expect(clickBatchToken([row("a"), row("b")])).toBe(clickBatchToken([row("a"), row("b")]));
  });

  it("differs when a row differs", () => {
    expect(clickBatchToken([row("a"), row("b")])).not.toBe(clickBatchToken([row("a"), row("c")]));
  });

  it("differs when the order differs", () => {
    /* The buffer always replays in the order it claimed, so a reordered batch is
       genuinely a different insert and must not be silently dropped. */
    expect(clickBatchToken([row("a"), row("b")])).not.toBe(clickBatchToken([row("b"), row("a")]));
  });

  it("differs when the batch is a prefix of another", () => {
    expect(clickBatchToken([row("a")])).not.toBe(clickBatchToken([row("a"), row("b")]));
  });

  it("does not collide when ids concatenate ambiguously", () => {
    /* Without the separator, ["ab","c"] and ["a","bc"] would hash identically. */
    expect(clickBatchToken([row("ab"), row("c")])).not.toBe(
      clickBatchToken([row("a"), row("bc")]),
    );
  });

  it("depends on nothing but the rows", () => {
    const first = clickBatchToken([row("a")]);
    const second = clickBatchToken([row("a")]);

    /* A clock or a random value in the token would make every retry look new,
       which is the exact bug the token exists to prevent. */
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("toClickHouseDateTime", () => {
  it("formats an instant the way ClickHouse's default parser reads it", () => {
    expect(toClickHouseDateTime(Date.parse("2026-08-07T10:00:00.000Z"))).toBe(
      "2026-08-07 10:00:00.000",
    );
  });

  it("keeps millisecond precision", () => {
    expect(toClickHouseDateTime(Date.parse("2026-08-07T10:00:00.456Z"))).toBe(
      "2026-08-07 10:00:00.456",
    );
  });

  it("emits UTC regardless of the machine's timezone", () => {
    /* The column is DateTime64(3, 'UTC') and this is the other half of that
       decision — a server timezone must never be able to shift a click by hours. */
    const formatted = toClickHouseDateTime(Date.parse("2026-08-07T23:30:00.000Z"));

    expect(formatted).toBe("2026-08-07 23:30:00.000");
    expect(formatted).not.toContain("Z");
    expect(formatted).not.toContain("T");
  });
});
