import { describe, expect, it } from "vitest";

import {
  BASE62_ALPHABET,
  DEFAULT_SLUG_LENGTH,
  decodeBase62,
  encodeBase62,
  generateSlug,
} from "./base62.js";

describe("encodeBase62", () => {
  it("encodes the boundaries of a single digit", () => {
    expect(encodeBase62(0)).toBe("0");
    expect(encodeBase62(9)).toBe("9");
    expect(encodeBase62(10)).toBe("A");
    expect(encodeBase62(35)).toBe("Z");
    expect(encodeBase62(36)).toBe("a");
    expect(encodeBase62(61)).toBe("z");
  });

  it("rolls over to two digits at 62", () => {
    expect(encodeBase62(62)).toBe("10");
    expect(encodeBase62(63)).toBe("11");
    expect(encodeBase62(62 * 62)).toBe("100");
  });

  it("accepts bigints beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = 2n ** 80n;
    expect(decodeBase62(encodeBase62(huge))).toBe(huge);
  });

  it("rejects negative and non-integer input", () => {
    expect(() => encodeBase62(-1)).toThrow(RangeError);
    expect(() => encodeBase62(-1n)).toThrow(RangeError);
    expect(() => encodeBase62(1.5)).toThrow(RangeError);
    expect(() => encodeBase62(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });
});

describe("decodeBase62", () => {
  it("round-trips every value in a dense range", () => {
    for (let value = 0; value < 5000; value += 1) {
      expect(decodeBase62(encodeBase62(value))).toBe(BigInt(value));
    }
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => decodeBase62("abc!")).toThrow(RangeError);
    expect(() => decodeBase62("hello world")).toThrow(RangeError);
    expect(() => decodeBase62("")).toThrow(RangeError);
  });

  it("is case sensitive", () => {
    expect(decodeBase62("A")).not.toBe(decodeBase62("a"));
  });
});

describe("generateSlug", () => {
  it("defaults to seven characters", () => {
    expect(generateSlug()).toHaveLength(DEFAULT_SLUG_LENGTH);
  });

  it("honours a requested length", () => {
    for (const length of [1, 4, 12, 64]) {
      expect(generateSlug(length)).toHaveLength(length);
    }
  });

  it("only emits base62 characters", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      expect(generateSlug(16)).toMatch(/^[0-9A-Za-z]{16}$/);
    }
  });

  it("does not collide across a large sample", () => {
    const slugs = new Set(Array.from({ length: 5000 }, () => generateSlug()));
    expect(slugs.size).toBe(5000);
  });

  it("reaches every character in the alphabet, showing rejection sampling is not truncating", () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      for (const char of generateSlug(16)) {
        seen.add(char);
      }
    }
    expect(seen.size).toBe(BASE62_ALPHABET.length);
  });

  it("rejects invalid lengths", () => {
    expect(() => generateSlug(0)).toThrow(RangeError);
    expect(() => generateSlug(-3)).toThrow(RangeError);
    expect(() => generateSlug(65)).toThrow(RangeError);
    expect(() => generateSlug(2.5)).toThrow(RangeError);
  });
});
