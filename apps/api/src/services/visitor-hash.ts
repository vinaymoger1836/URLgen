/**
 * Visitor identity without storing an identity.
 *
 * The analytics table has no IP column and never will. What it stores is
 * `HMAC(salt_of_today, ip + user-agent + slug)` — enough to answer "how many
 * distinct people clicked this link today?", and not enough to answer anything
 * else, because the salt is thrown away when the day turns over.
 *
 * Three properties, each deliberate:
 *
 * - **The salt rotates daily.** Yesterday's hashes cannot be re-derived from
 *   today's inputs, so the stored column stops being a stable identifier the
 *   moment the day ends. A visitor who returns tomorrow is a new visitor. That is
 *   a real loss of fidelity and it is the point.
 * - **The hash is scoped to the slug.** Two links owned by the same person cannot
 *   be joined on `visitor_hash` to follow one person across them. The cost is that
 *   "unique visitors across all my links" is not a question this schema can answer;
 *   per-link uniques, which is what the dashboard shows, still work exactly.
 * - **It is an HMAC, not a plain digest.** `sha256(ip)` is reversible in seconds:
 *   the entire IPv4 space is 4 billion values and a laptop will rainbow-table it
 *   over lunch. The secret salt is what makes the pre-image search infeasible.
 *
 * The IP itself lives in one function argument and one HMAC update. It is never
 * logged, never buffered, never persisted.
 */

import { createHmac, randomBytes } from "node:crypto";

/**
 * Width of the stored hash, in hex characters.
 *
 * 128 bits: collisions are unreachable at any volume this project will see, and
 * it halves the bytes ClickHouse keeps per row against a full SHA-256.
 */
const HASH_HEX_LENGTH = 32;

export interface VisitorHasherOptions {
  /** The long-lived seed from the environment. Absent only in local development. */
  salt?: string | undefined;
  /** Called once when no seed was configured, so the fallback is never silent. */
  onMissingSalt?: (() => void) | undefined;
}

export interface VisitorFingerprint {
  slug: string;
  ip: string | undefined;
  userAgent: string | undefined;
  /** The click's idempotency key — the fallback identity when there is no IP. */
  eventId: string;
  /** When the click happened, epoch milliseconds. Chooses which day's salt applies. */
  ts: number;
}

/**
 * Computes salted, daily-rotating visitor hashes.
 *
 * Stateful only in that it memoizes the day's derived salt — deriving it per click
 * would mean an extra HMAC on every event for a value that changes once a day.
 */
export class VisitorHasher {
  readonly #seed: Buffer;
  #cachedDay = "";
  #cachedSalt: Buffer = Buffer.alloc(0);

  public constructor(options: VisitorHasherOptions = {}) {
    if (options.salt === undefined || options.salt === "") {
      /* An ephemeral seed keeps local development working without a configured
         secret. It is not a production fallback: hashes stop being comparable
         across restarts, which is exactly why the config schema requires the real
         value when NODE_ENV=production. */
      this.#seed = randomBytes(32);
      options.onMissingSalt?.();
    } else {
      this.#seed = Buffer.from(options.salt, "utf8");
    }
  }

  /**
   * Returns the visitor hash for a click, and never returns the input.
   *
   * With no IP available the click's own idempotency key stands in, which makes it
   * count as one unique visitor. That over-counts, and it is the right direction to
   * be wrong in: collapsing every IP-less click onto one shared hash would fold an
   * unbounded number of real people into a single "visitor".
   */
  public hash(fingerprint: VisitorFingerprint): string {
    const salt = this.#saltFor(fingerprint.ts);

    if (fingerprint.ip === undefined || fingerprint.ip === "") {
      return createHmac("sha256", salt)
        .update(`no-ip\n${fingerprint.eventId}`)
        .digest("hex")
        .slice(0, HASH_HEX_LENGTH);
    }

    /* Newline-separated so a crafted User-Agent cannot shift the field boundary
       and make two different visitors hash identically. */
    return createHmac("sha256", salt)
      .update(fingerprint.ip)
      .update("\n")
      .update(fingerprint.userAgent ?? "")
      .update("\n")
      .update(fingerprint.slug)
      .digest("hex")
      .slice(0, HASH_HEX_LENGTH);
  }

  /**
   * Derives (and memoizes) the salt for the click's UTC day.
   *
   * UTC rather than a local zone so every replica of this service agrees on when
   * the rotation happens. A visitor clicking either side of midnight UTC is
   * counted twice; that is the rotation working, not a bug.
   */
  #saltFor(ts: number): Buffer {
    const day = utcDay(ts);
    if (day !== this.#cachedDay) {
      this.#cachedSalt = createHmac("sha256", this.#seed).update(day).digest();
      this.#cachedDay = day;
    }
    return this.#cachedSalt;
  }
}

/** The UTC calendar day of an instant, as `YYYY-MM-DD`. */
export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
