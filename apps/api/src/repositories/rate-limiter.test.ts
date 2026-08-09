/**
 * The in-memory limiter's semantics, which the Redis one has to match.
 *
 * These are the rules both implementations are held to; `rate-limiter-integration.test.ts`
 * runs the same shapes against a real Redis, where the atomicity claim can actually
 * be tested.
 */

import { describe, expect, it } from "vitest";

import { InMemoryRateLimiter, NoopRateLimiter, type RateLimitRule } from "./rate-limiter.js";

const rule: RateLimitRule = { limit: 3, windowMs: 60_000 };
const start = Date.parse("2026-08-09T12:00:00.000Z");

describe("InMemoryRateLimiter", () => {
  it("allows up to the limit and refuses the next one", async () => {
    const limiter = new InMemoryRateLimiter();

    for (let index = 0; index < 3; index += 1) {
      const decision = await limiter.consume("k", rule, start);
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(2 - index);
    }

    const refused = await limiter.consume("k", rule, start);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
  });

  it("keys are independent", async () => {
    const limiter = new InMemoryRateLimiter();

    await limiter.consume("a", rule, start);
    await limiter.consume("a", rule, start);
    await limiter.consume("a", rule, start);

    expect((await limiter.consume("a", rule, start)).allowed).toBe(false);
    expect((await limiter.consume("b", rule, start)).allowed).toBe(true);
  });

  it("slides: capacity returns as the oldest request ages out, not at a bucket boundary", async () => {
    const limiter = new InMemoryRateLimiter();

    /* Three requests spread across the window. */
    await limiter.consume("k", rule, start);
    await limiter.consume("k", rule, start + 30_000);
    await limiter.consume("k", rule, start + 40_000);

    expect((await limiter.consume("k", rule, start + 41_000)).allowed).toBe(false);

    /* One millisecond after the first falls out of the trailing window, and only
       one slot is back — the other two are still inside it. This is the whole
       difference from a fixed window, which would have handed back all three. */
    const afterFirstExpires = await limiter.consume("k", rule, start + 60_001);
    expect(afterFirstExpires.allowed).toBe(true);
    expect(afterFirstExpires.remaining).toBe(0);
  });

  it("reports the reset as when the oldest surviving request ages out", async () => {
    const limiter = new InMemoryRateLimiter();

    await limiter.consume("k", rule, start);
    await limiter.consume("k", rule, start + 10_000);
    await limiter.consume("k", rule, start + 20_000);

    const refused = await limiter.consume("k", rule, start + 25_000);
    /* Not `now + window` — that would overstate the wait by 25 seconds. */
    expect(refused.resetAtMs).toBe(start + 60_000);
  });

  it("a refused request is not recorded, so hammering cannot extend the wait", async () => {
    const limiter = new InMemoryRateLimiter();

    for (let index = 0; index < 3; index += 1) {
      await limiter.consume("k", rule, start);
    }

    /* Fifty refusals later, the window still ends when the original three do. */
    for (let index = 0; index < 50; index += 1) {
      await limiter.consume("k", rule, start + 1_000 + index);
    }

    const refused = await limiter.consume("k", rule, start + 59_000);
    expect(refused.resetAtMs).toBe(start + 60_000);
    expect((await limiter.consume("k", rule, start + 60_001)).allowed).toBe(true);
  });
});

describe("NoopRateLimiter", () => {
  it("allows everything and still reports a coherent budget", async () => {
    const limiter = new NoopRateLimiter();

    for (let index = 0; index < 100; index += 1) {
      const decision = await limiter.consume("k", rule, start);
      expect(decision.allowed).toBe(true);
      /* Full budget every time: a caller reading these headers must not conclude
         it is close to a limit that is not being enforced. */
      expect(decision.remaining).toBe(3);
    }
  });
});
