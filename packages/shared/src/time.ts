/**
 * Timezone arithmetic, without a timezone library.
 *
 * The dashboard's day boundaries belong to the viewer, not to the server: "the
 * last 7 days" for someone in Kolkata starts at 18:30 UTC, and a chart that
 * buckets by UTC midnight would show them a day that ends in the middle of their
 * afternoon. So every range and every day bucket is computed in a named IANA zone.
 *
 * `Intl.DateTimeFormat` already ships the full tz database in Node and in every
 * browser, so the only thing missing is arithmetic on top of it — about forty
 * lines. A dependency (`date-fns-tz`, `luxon`) would add a second copy of rules
 * the runtime already has, and this module is imported by the Worker's package
 * too, where every kilobyte is on the hot path.
 *
 * Everything here takes and returns epoch milliseconds. A wall-clock time is never
 * a return value: it is ambiguous twice a year, and an instant never is.
 */

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/**
 * `formatToParts` is the only API that exposes a zone's offset, and building a
 * formatter is expensive relative to using one. The set of zones a process sees is
 * bounded by its users, so caching them all is safe.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * The canonical IANA name for a zone, or `undefined` if the runtime does not know it.
 *
 * Canonicalizing matters beyond validation: `Intl` accepts "asia/kolkata" and
 * "UTC" in any case, while ClickHouse's `toStartOfDay(t, tz)` wants the exact
 * database name. Normalizing here means the string that reaches a query has already
 * been through a lookup table rather than merely a regex.
 */
export function normalizeTimeZone(timeZone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    /* RangeError is the documented signal for an unknown zone. */
    return undefined;
  }
}

/** True when the runtime recognises the zone. */
export function isValidTimeZone(timeZone: string): boolean {
  return normalizeTimeZone(timeZone) !== undefined;
}

/**
 * Milliseconds to add to UTC to reach wall-clock time in `timeZone` at `instant`.
 *
 * Positive east of Greenwich. Second precision, which is all any real zone uses —
 * the sub-minute offsets in the tz database are all pre-1900.
 */
export function timeZoneOffsetMs(instant: number, timeZone: string): number {
  const parts = partsFormatterFor(timeZone).formatToParts(new Date(instant));

  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;

  for (const part of parts) {
    const value = Number(part.value);
    switch (part.type) {
      case "year":
        year = value;
        break;
      case "month":
        month = value;
        break;
      case "day":
        day = value;
        break;
      case "hour":
        hour = value;
        break;
      case "minute":
        minute = value;
        break;
      case "second":
        second = value;
        break;
      default:
        break;
    }
  }

  /* Read the wall clock back as if it were UTC; the difference from the real
     instant is the offset. Milliseconds are dropped from both sides so they cancel
     rather than leaking into the result. */
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asIfUtc - (instant - modulo(instant, 1000));
}

/**
 * The instant at which the calendar day containing `instant` begins in `timeZone`.
 *
 * Two passes, and the second one is not optional: the offset used to find the
 * candidate midnight is the offset *at the original instant*, which on a DST
 * transition day is not the offset at midnight. Correcting once is enough because
 * a zone changes offset at most once per day.
 */
export function zonedStartOfDay(instant: number, timeZone: string): number {
  const offset = timeZoneOffsetMs(instant, timeZone);
  const wallDayStart = floorTo(instant + offset, MS_PER_DAY);

  const candidate = wallDayStart - offset;
  const candidateOffset = timeZoneOffsetMs(candidate, timeZone);
  if (candidateOffset === offset) {
    return candidate;
  }

  return wallDayStart - candidateOffset;
}

/**
 * The instant `days` calendar days from the start of `instant`'s day, in `timeZone`.
 *
 * Steps through noon rather than adding a flat 24 hours, because a DST day is 23 or
 * 25 hours long: adding exactly one day to midnight on a 25-hour day lands at 23:00
 * of the *same* day, and the result would silently repeat a bucket. Anchoring at
 * midday keeps the arithmetic inside the target day whichever way the clocks moved.
 */
export function addZonedDays(instant: number, days: number, timeZone: string): number {
  const start = zonedStartOfDay(instant, timeZone);
  return zonedStartOfDay(start + days * MS_PER_DAY + MS_PER_DAY / 2, timeZone);
}

/**
 * The instant at which the hour containing `instant` begins in `timeZone`.
 *
 * Not the same as flooring to a whole hour of UTC: zones offset by 30 or 45 minutes
 * (India, Nepal, parts of Australia) put their hour boundaries at :30 and :45 past
 * the UTC hour, and a chart labelled in local time has to agree with its own axis.
 */
export function zonedStartOfHour(instant: number, timeZone: string): number {
  const offset = timeZoneOffsetMs(instant, timeZone);
  return floorTo(instant + offset, MS_PER_HOUR) - offset;
}

/** Floors to a multiple of `step`, correctly for instants before 1970. */
function floorTo(value: number, step: number): number {
  return value - modulo(value, step);
}

/** Remainder that is never negative — `%` in JavaScript keeps the sign of the dividend. */
function modulo(value: number, step: number): number {
  return ((value % step) + step) % step;
}
