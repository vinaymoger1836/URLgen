import { describe, expect, it } from "vitest";

import {
  addZonedDays,
  isValidTimeZone,
  normalizeTimeZone,
  timeZoneOffsetMs,
  zonedStartOfDay,
  zonedStartOfHour,
  zonedStartOfInterval,
} from "./time.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("normalizeTimeZone", () => {
  it("returns a usable name for a known zone", () => {
    expect(normalizeTimeZone("UTC")).toBe("UTC");
    expect(normalizeTimeZone("America/New_York")).toBe("America/New_York");
  });

  it("canonicalizes case, which ClickHouse will not do for us", () => {
    expect(normalizeTimeZone("america/new_york")).toBe("America/New_York");
  });

  it("may return a legacy alias — canonical is not the same as modern", () => {
    /* This runtime resolves Asia/Kolkata to Asia/Calcutta, the pre-1993 name that
       the IANA database still lists as canonical. Both are in the tz database's
       backward links, so ClickHouse accepts either and the offset is identical —
       but an equality assertion against the modern spelling would fail here and
       pass on a runtime with newer ICU. What has to hold is that the output is
       stable and means the same instant, not that it is spelled the modern way. */
    const normalized = normalizeTimeZone("Asia/Kolkata") ?? "";
    expect(normalized).not.toBe("");
    expect(normalizeTimeZone(normalized)).toBe(normalized);
    expect(timeZoneOffsetMs(Date.UTC(2026, 6, 1), normalized)).toBe(5 * HOUR + 30 * MINUTE);
  });

  it("returns undefined rather than throwing for an unknown zone", () => {
    expect(normalizeTimeZone("Mars/Olympus_Mons")).toBeUndefined();
    expect(normalizeTimeZone("")).toBeUndefined();
    expect(isValidTimeZone("Not/AZone")).toBe(false);
  });
});

describe("timeZoneOffsetMs", () => {
  it("is zero for UTC", () => {
    expect(timeZoneOffsetMs(Date.UTC(2026, 6, 1), "UTC")).toBe(0);
  });

  it("handles a half-hour offset", () => {
    /* India is +05:30 year round — the case that breaks any implementation that
       assumes offsets are whole hours. */
    expect(timeZoneOffsetMs(Date.UTC(2026, 6, 1), "Asia/Kolkata")).toBe(5 * HOUR + 30 * MINUTE);
  });

  it("handles a negative offset", () => {
    expect(timeZoneOffsetMs(Date.UTC(2026, 0, 15, 12), "America/New_York")).toBe(-5 * HOUR);
  });

  it("follows the zone across a DST transition", () => {
    /* US DST began 2026-03-08 at 07:00 UTC. */
    const before = Date.UTC(2026, 2, 8, 6, 0);
    const after = Date.UTC(2026, 2, 8, 8, 0);
    expect(timeZoneOffsetMs(before, "America/New_York")).toBe(-5 * HOUR);
    expect(timeZoneOffsetMs(after, "America/New_York")).toBe(-4 * HOUR);
  });

  it("ignores the sub-second part of the instant", () => {
    const instant = Date.UTC(2026, 6, 1, 3, 4, 5) + 789;
    expect(timeZoneOffsetMs(instant, "Asia/Kolkata")).toBe(5 * HOUR + 30 * MINUTE);
  });
});

describe("zonedStartOfDay", () => {
  it("is UTC midnight in UTC", () => {
    const noon = Date.UTC(2026, 7, 8, 12, 0);
    expect(zonedStartOfDay(noon, "UTC")).toBe(Date.UTC(2026, 7, 8));
  });

  it("is 18:30 the previous UTC day for a +05:30 zone", () => {
    const instant = Date.UTC(2026, 7, 8, 12, 0);
    expect(zonedStartOfDay(instant, "Asia/Kolkata")).toBe(Date.UTC(2026, 7, 7, 18, 30));
  });

  it("is idempotent", () => {
    const instant = Date.UTC(2026, 7, 8, 12, 0);
    const start = zonedStartOfDay(instant, "Asia/Kolkata");
    expect(zonedStartOfDay(start, "Asia/Kolkata")).toBe(start);
  });

  it("uses the offset at midnight, not the offset at the instant", () => {
    /* Evening of a spring-forward day: the offset then is -04:00, but that day
       started while the zone was still at -05:00. A single-pass implementation
       returns 05:00 UTC here, which is an hour into the previous day. */
    const evening = Date.UTC(2026, 2, 8, 22, 0);
    expect(zonedStartOfDay(evening, "America/New_York")).toBe(Date.UTC(2026, 2, 8, 5, 0));
  });

  it("handles the fall-back day, where the same wall clock happens twice", () => {
    /* US DST ended 2026-11-01 at 06:00 UTC. Midnight local is still -04:00. */
    const evening = Date.UTC(2026, 10, 1, 20, 0);
    expect(zonedStartOfDay(evening, "America/New_York")).toBe(Date.UTC(2026, 10, 1, 4, 0));
  });
});

describe("addZonedDays", () => {
  it("steps whole calendar days", () => {
    const start = Date.UTC(2026, 7, 8, 9, 30);
    expect(addZonedDays(start, -6, "UTC")).toBe(Date.UTC(2026, 7, 2));
  });

  it("snaps to the start of the day even with a zero step", () => {
    const start = Date.UTC(2026, 7, 8, 9, 30);
    expect(addZonedDays(start, 0, "UTC")).toBe(Date.UTC(2026, 7, 8));
  });

  it("crosses a 23-hour day without skipping it", () => {
    /* 2026-03-08 is 23 hours long in New York. Stepping forward from the 7th must
       land on the 8th, not overshoot into the 9th. */
    const seventh = Date.UTC(2026, 2, 7, 12, 0);
    expect(addZonedDays(seventh, 1, "America/New_York")).toBe(Date.UTC(2026, 2, 8, 5, 0));
  });

  it("crosses a 25-hour day without repeating it", () => {
    /* 2026-11-01 is 25 hours long. A flat +24h from its midnight lands at 23:00 of
       the same local day, and a naive implementation emits the 1st twice. */
    const first = Date.UTC(2026, 10, 1, 12, 0);
    expect(addZonedDays(first, 1, "America/New_York")).toBe(Date.UTC(2026, 10, 2, 5, 0));
  });

  it("produces a strictly increasing sequence across a DST boundary", () => {
    let cursor = Date.UTC(2026, 2, 5, 0, 0);
    const seen: number[] = [];
    for (let day = 0; day < 6; day += 1) {
      cursor = addZonedDays(cursor, 1, "America/New_York");
      seen.push(cursor);
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("zonedStartOfHour", () => {
  it("floors to the UTC hour in UTC", () => {
    expect(zonedStartOfHour(Date.UTC(2026, 7, 8, 14, 37, 12), "UTC")).toBe(
      Date.UTC(2026, 7, 8, 14, 0),
    );
  });

  it("floors to :30 past in a half-hour zone", () => {
    /* 14:37 UTC is 20:07 in Kolkata, whose hour began at 19:30 local = 14:00 UTC.
       Flooring to the UTC hour happens to agree here, so check a case where it
       does not: 14:20 UTC is 19:50 local, whose hour began at 13:30 UTC. */
    expect(zonedStartOfHour(Date.UTC(2026, 7, 8, 14, 20), "Asia/Kolkata")).toBe(
      Date.UTC(2026, 7, 8, 13, 30),
    );
  });
});

describe("zonedStartOfInterval", () => {
  it("aligns quarter-hours to the zone", () => {
    const instant = Date.UTC(2026, 7, 8, 14, 22);
    expect(zonedStartOfInterval(instant, 900_000, "UTC")).toBe(Date.UTC(2026, 7, 8, 14, 15));
    /* +05:30 is itself a multiple of 15 minutes, so quarter-hour boundaries land on
       the same instants — the case that would break is an offset that is not. */
    expect(zonedStartOfInterval(instant, 900_000, "Asia/Kolkata")).toBe(
      Date.UTC(2026, 7, 8, 14, 15),
    );
  });

  it("produces boundaries that are stable under re-flooring", () => {
    const start = zonedStartOfInterval(Date.UTC(2026, 7, 8, 14, 22), 900_000, "Asia/Kolkata");
    expect(zonedStartOfInterval(start, 900_000, "Asia/Kolkata")).toBe(start);
  });
});
