/**
 * Presentation helpers.
 *
 * Pure functions with no React in them, so the parts most likely to be quietly
 * wrong — bucket labels in a timezone that is not the machine's, an empty referrer
 * meaning "typed directly" — are testable without rendering anything.
 */

import type { AnalyticsGranularity } from "@urlgen/shared";

/** Compacts a count the way a stat tile wants it: 1,284 / 12.9K / 4.2M. */
export function formatCount(value: number): string {
  if (value < 10_000) {
    return value.toLocaleString("en-US");
  }
  if (value < 1_000_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** A share of a total, as a rounded percentage. Zero total reads as 0%, not NaN. */
export function formatShare(value: number, total: number): string {
  if (total <= 0) {
    return "0%";
  }
  return `${Math.round((value / total) * 100).toString()}%`;
}

/**
 * The axis label for a bucket, in the window's timezone.
 *
 * The timezone is explicit rather than the browser's, because the server bucketed
 * the data in a named zone and an axis that disagrees with its own buckets is worse
 * than one in the "wrong" zone.
 */
export function formatBucket(
  iso: string,
  granularity: AnalyticsGranularity,
  timeZone: string,
): string {
  const date = new Date(iso);
  const options: Intl.DateTimeFormatOptions =
    granularity === "day"
      ? { month: "short", day: "numeric" }
      : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

  return new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(date);
}

/** The full instant for a tooltip, where there is room to be unambiguous. */
export function formatInstant(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(iso));
}

/** A date with no time, for link metadata. */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

/**
 * The label for a breakdown key.
 *
 * The API returns exactly what was stored, empty strings included, because "" is a
 * real value in two of these dimensions — a click with no `Referer` header came from
 * someone typing or pasting the link, and that is a genuine finding rather than
 * missing data. Naming it is this layer's job, not the store's.
 */
export function formatBreakdownKey(dimension: string, key: string): string {
  if (key === "") {
    return dimension === "referrer" ? "Direct" : "Unknown";
  }
  if (key === "unknown" || key === "XX") {
    return "Unknown";
  }
  if (dimension === "country") {
    return countryName(key);
  }
  if (dimension === "deviceType") {
    return key.charAt(0).toUpperCase() + key.slice(1);
  }
  return key;
}

/**
 * A country's name from its two-letter code.
 *
 * `Intl.DisplayNames` ships the CLDR list in the browser, so there is no table to
 * embed and no list to go stale. An unrecognised code falls back to itself — better
 * a bare "ZZ" in the panel than an exception in a render.
 */
function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) {
    return code;
  }
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Human-readable name for each breakdown panel. */
export const DIMENSION_LABELS: Readonly<Record<string, string>> = {
  country: "Country",
  deviceType: "Device",
  browser: "Browser",
  os: "Operating system",
  referrer: "Referrer",
};

/** How the range selector reads. */
export const RANGE_LABELS: Readonly<Record<string, string>> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};
