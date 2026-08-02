import { describe, expect, it } from "vitest";

import { generateSlug } from "./base62.js";
import { isReservedSlug, isWellFormedSlug, validateCustomSlug } from "./slug.js";

describe("isWellFormedSlug", () => {
  it("accepts generated slugs", () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(isWellFormedSlug(generateSlug())).toBe(true);
    }
  });

  it("accepts hyphens and underscores", () => {
    expect(isWellFormedSlug("my-link_2")).toBe(true);
  });

  it("rejects paths, spaces and empty strings", () => {
    expect(isWellFormedSlug("")).toBe(false);
    expect(isWellFormedSlug("a/b")).toBe(false);
    expect(isWellFormedSlug("a b")).toBe(false);
    expect(isWellFormedSlug("a.b")).toBe(false);
    expect(isWellFormedSlug("../etc")).toBe(false);
    expect(isWellFormedSlug("a".repeat(33))).toBe(false);
  });
});

describe("isReservedSlug", () => {
  it("matches regardless of case", () => {
    expect(isReservedSlug("api")).toBe(true);
    expect(isReservedSlug("API")).toBe(true);
    expect(isReservedSlug("Dashboard")).toBe(true);
  });

  it("leaves ordinary slugs alone", () => {
    expect(isReservedSlug("apifoo")).toBe(false);
    expect(isReservedSlug("xY7bQ2z")).toBe(false);
  });
});

describe("validateCustomSlug", () => {
  it("accepts a reasonable custom slug", () => {
    expect(validateCustomSlug("launch-2026")).toEqual({ valid: true });
  });

  it("reports the specific reason for each rejection", () => {
    expect(validateCustomSlug("ab")).toEqual({ valid: false, reason: "too-short" });
    expect(validateCustomSlug("a".repeat(33))).toEqual({ valid: false, reason: "too-long" });
    expect(validateCustomSlug("bad slug")).toEqual({ valid: false, reason: "invalid-characters" });
    expect(validateCustomSlug("api")).toEqual({ valid: false, reason: "reserved" });
    expect(validateCustomSlug("-lead")).toEqual({
      valid: false,
      reason: "leading-or-trailing-separator",
    });
    expect(validateCustomSlug("trail_")).toEqual({
      valid: false,
      reason: "leading-or-trailing-separator",
    });
  });

  it("checks length before character content, so the message is the most useful one", () => {
    expect(validateCustomSlug("a/")).toEqual({ valid: false, reason: "too-short" });
  });
});
