/**
 * Base62 encoding and cryptographically secure slug generation.
 *
 * Slugs are random, not sequential. A monotonic counter would need distributed
 * coordination (and would leak how many links exist); random allocation plus a
 * DynamoDB conditional write gives uniqueness without any coordination at all.
 */

/** Digits first, then uppercase, then lowercase — so base62 order matches ASCII order. */
export const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const BASE = BigInt(BASE62_ALPHABET.length);

const CHAR_TO_VALUE: ReadonlyMap<string, number> = new Map(
  Array.from(BASE62_ALPHABET, (char, index) => [char, index] as const),
);

/** Default slug length: 62^7 ≈ 3.5e12 possibilities. */
export const DEFAULT_SLUG_LENGTH = 7;

/** Encodes a non-negative integer as base62. */
export function encodeBase62(value: bigint | number): string {
  const n = toNonNegativeBigInt(value);
  if (n === 0n) {
    return BASE62_ALPHABET.charAt(0);
  }

  let remaining = n;
  let encoded = "";
  while (remaining > 0n) {
    encoded = BASE62_ALPHABET.charAt(Number(remaining % BASE)) + encoded;
    remaining /= BASE;
  }
  return encoded;
}

/** Decodes a base62 string back to an integer. Throws on any character outside the alphabet. */
export function decodeBase62(encoded: string): bigint {
  if (encoded.length === 0) {
    throw new RangeError("decodeBase62 requires a non-empty string");
  }

  let value = 0n;
  for (const char of encoded) {
    const digit = CHAR_TO_VALUE.get(char);
    if (digit === undefined) {
      throw new RangeError(`decodeBase62 received a non-base62 character: ${JSON.stringify(char)}`);
    }
    value = value * BASE + BigInt(digit);
  }
  return value;
}

/**
 * Generates a random base62 slug using the platform CSPRNG.
 *
 * Uses rejection sampling: 256 is not a multiple of 62, so naively taking
 * `byte % 62` would make the first eight characters of the alphabet ~1.6x more
 * likely than the rest. Bytes at or above the largest multiple of 62 (248) are
 * discarded instead.
 */
export function generateSlug(length: number = DEFAULT_SLUG_LENGTH): string {
  if (!Number.isInteger(length) || length < 1 || length > 64) {
    throw new RangeError("generateSlug length must be an integer between 1 and 64");
  }

  const alphabetSize = BASE62_ALPHABET.length;
  const unbiasedCeiling = 256 - (256 % alphabetSize);
  const buffer = new Uint8Array(length);
  let slug = "";

  while (slug.length < length) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte >= unbiasedCeiling) {
        continue;
      }
      slug += BASE62_ALPHABET.charAt(byte % alphabetSize);
      if (slug.length === length) {
        break;
      }
    }
  }

  return slug;
}

function toNonNegativeBigInt(value: bigint | number): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("encodeBase62 requires a safe integer when given a number");
    }
    if (value < 0) {
      throw new RangeError("encodeBase62 requires a non-negative value");
    }
    return BigInt(value);
  }

  if (value < 0n) {
    throw new RangeError("encodeBase62 requires a non-negative value");
  }
  return value;
}
