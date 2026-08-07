import { describe, expect, it, vi } from "vitest";

import { VisitorHasher, utcDay, type VisitorFingerprint } from "./visitor-hash.js";

const SALT = "a-test-seed-of-at-least-16-chars";
const DAY_ONE = Date.parse("2026-08-07T12:00:00.000Z");
const DAY_TWO = Date.parse("2026-08-08T12:00:00.000Z");

function fingerprint(overrides: Partial<VisitorFingerprint> = {}): VisitorFingerprint {
  return {
    slug: "abc1234",
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15",
    eventId: "11111111-1111-4111-8111-111111111111",
    ts: DAY_ONE,
    ...overrides,
  };
}

function hasher(): VisitorHasher {
  return new VisitorHasher({ salt: SALT });
}

describe("VisitorHasher", () => {
  it("gives the same visitor the same hash within a day", () => {
    const subject = hasher();

    const first = subject.hash(fingerprint());
    const second = subject.hash(fingerprint({ ts: DAY_ONE + 3_600_000 }));

    expect(first).toBe(second);
  });

  it("is stable across instances, so a restart does not reset the day's counts", () => {
    expect(hasher().hash(fingerprint())).toBe(hasher().hash(fingerprint()));
  });

  it("gives a different hash to a different IP", () => {
    const subject = hasher();

    expect(subject.hash(fingerprint())).not.toBe(subject.hash(fingerprint({ ip: "198.51.100.4" })));
  });

  it("gives a different hash to a different User-Agent on the same IP", () => {
    const subject = hasher();

    /* Two people behind one NAT are two visitors, as far as this can tell. */
    expect(subject.hash(fingerprint())).not.toBe(
      subject.hash(fingerprint({ userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/131" })),
    );
  });

  it("rotates the salt daily, so yesterday's hash cannot be reproduced", () => {
    const subject = hasher();

    const today = subject.hash(fingerprint({ ts: DAY_ONE }));
    const tomorrow = subject.hash(fingerprint({ ts: DAY_TWO }));

    /* This is the privacy mechanism, not a bug: a returning visitor is a new
       visitor tomorrow, and the stored column stops being a stable identifier. */
    expect(today).not.toBe(tomorrow);
  });

  it("rotates on the UTC boundary so replicas in different zones agree", () => {
    const subject = hasher();
    const justBefore = Date.parse("2026-08-07T23:59:59.000Z");
    const justAfter = Date.parse("2026-08-08T00:00:01.000Z");

    expect(subject.hash(fingerprint({ ts: justBefore }))).not.toBe(
      subject.hash(fingerprint({ ts: justAfter })),
    );
  });

  it("returns to the earlier day's hash when an out-of-order click arrives", () => {
    const subject = hasher();

    const first = subject.hash(fingerprint({ ts: DAY_ONE }));
    subject.hash(fingerprint({ ts: DAY_TWO }));
    const replayed = subject.hash(fingerprint({ ts: DAY_ONE }));

    /* The buffer can hold events across a midnight boundary, so the memoized salt
       must follow the event's timestamp, not the order they happen to arrive in. */
    expect(replayed).toBe(first);
  });

  it("scopes the hash to the slug so two links cannot be joined on it", () => {
    const subject = hasher();

    expect(subject.hash(fingerprint({ slug: "aaa1111" }))).not.toBe(
      subject.hash(fingerprint({ slug: "bbb2222" })),
    );
  });

  it("changes completely when the seed changes", () => {
    const withSeed = new VisitorHasher({ salt: SALT }).hash(fingerprint());
    const withOther = new VisitorHasher({ salt: "a-different-seed-entirely!!" }).hash(
      fingerprint(),
    );

    expect(withSeed).not.toBe(withOther);
  });

  it("never emits the IP or the User-Agent it was given", () => {
    const result = hasher().hash(fingerprint());

    expect(result).not.toContain("203.0.113.7");
    expect(result).not.toContain("Macintosh");
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is not a bare digest of the inputs", () => {
    /* `sha256(ip)` is reversible: the whole IPv4 space is 4 billion values. The
       secret salt is the only reason this is not trivially inverted. */
    const unsalted = new VisitorHasher({ salt: "" });
    const salted = hasher();

    expect(salted.hash(fingerprint())).not.toBe(unsalted.hash(fingerprint()));
  });

  describe("without an IP", () => {
    it("counts each click as its own visitor rather than folding them together", () => {
      const subject = hasher();

      const first = subject.hash(fingerprint({ ip: undefined, eventId: "event-a" }));
      const second = subject.hash(fingerprint({ ip: undefined, eventId: "event-b" }));

      /* Over-counting is the right direction to be wrong in: one shared hash would
         collapse an unbounded number of real people into a single "visitor". */
      expect(first).not.toBe(second);
    });

    it("treats an empty IP the same as an absent one", () => {
      const subject = hasher();

      expect(subject.hash(fingerprint({ ip: "", eventId: "event-a" }))).toBe(
        subject.hash(fingerprint({ ip: undefined, eventId: "event-a" })),
      );
    });
  });

  describe("with no configured seed", () => {
    it("warns rather than failing silently", () => {
      const onMissingSalt = vi.fn();

      new VisitorHasher({ salt: undefined, onMissingSalt });

      expect(onMissingSalt).toHaveBeenCalledTimes(1);
    });

    it("still produces usable hashes for local development", () => {
      const subject = new VisitorHasher({});

      expect(subject.hash(fingerprint())).toMatch(/^[0-9a-f]{32}$/);
      expect(subject.hash(fingerprint())).toBe(subject.hash(fingerprint()));
    });

    it("does not agree with another instance, which is why production requires a seed", () => {
      expect(new VisitorHasher({}).hash(fingerprint())).not.toBe(
        new VisitorHasher({}).hash(fingerprint()),
      );
    });
  });
});

describe("utcDay", () => {
  it("formats the UTC calendar day", () => {
    expect(utcDay(Date.parse("2026-08-07T23:59:59.999Z"))).toBe("2026-08-07");
    expect(utcDay(Date.parse("2026-08-08T00:00:00.000Z"))).toBe("2026-08-08");
  });
});
