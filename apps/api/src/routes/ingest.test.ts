import { CLICK_INGEST_PATH, type ClickEvent } from "@urlgen/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClickRow } from "../analytics/click-row.js";
import { loadConfig } from "../config.js";
import type { ClickBuffer } from "../repositories/click-buffer.js";
import { InMemoryClickBuffer } from "../repositories/in-memory-click-buffer.js";
import { buildServer } from "../server.js";

const TOKEN = "t".repeat(40);
const SALT = "a-test-seed-of-at-least-16-chars";

const IP = "203.0.113.7";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

function event(overrides: Partial<ClickEvent> = {}): ClickEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "abc1234",
    ts: Date.parse("2026-08-07T10:15:00.000Z"),
    country: "IN",
    city: "Bengaluru",
    timezone: "Asia/Kolkata",
    colo: "BOM",
    userAgent: IPHONE,
    referrer: "https://news.ycombinator.com/item?id=42&token=secret",
    ip: IP,
    ...overrides,
  };
}

let app: FastifyInstance;
let buffer: InMemoryClickBuffer;

function buildWith(
  overrides: { token?: string | undefined; buffer?: ClickBuffer; salt?: string } = {},
): FastifyInstance {
  const config = loadConfig({
    NODE_ENV: "test",
    VISITOR_HASH_SALT: overrides.salt ?? SALT,
    ...(overrides.token !== undefined ? { INTERNAL_API_TOKEN: overrides.token } : {}),
  });
  return buildServer(config, { buffer: overrides.buffer ?? buffer });
}

/** `null` omits the header entirely — `undefined` would silently take the default. */
function ingest(body: unknown, token: string | null = TOKEN) {
  return app.inject({
    method: "POST",
    url: CLICK_INGEST_PATH,
    ...(token !== null ? { headers: { "x-internal-token": token } } : {}),
    payload: body as Record<string, unknown>,
  });
}

/** The single row the buffer accepted, for asserting on the enrichment. */
async function bufferedRow(): Promise<ClickRow> {
  const batch = await buffer.drain(10);
  const row = batch.rows[0];
  if (row === undefined) {
    throw new Error("nothing was buffered");
  }
  return row;
}

describe("POST /ingest/click", () => {
  beforeEach(async () => {
    buffer = new InMemoryClickBuffer();
    app = buildWith({ token: TOKEN });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("authentication", () => {
    it("accepts a call carrying the shared token", async () => {
      const response = await ingest(event());

      expect(response.statusCode).toBe(202);
    });

    it.each([
      ["no token", null],
      ["a wrong token", "x".repeat(40)],
      ["a token of the wrong length", "short"],
    ])("rejects %s with 401", async (_label, token) => {
      const response = await ingest(event(), token);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: "unauthorized", message: "Invalid internal token" },
      });
    });

    it("buffers nothing when the call is unauthenticated", async () => {
      await ingest(event(), "x".repeat(40));

      /* Forged clicks would land in someone else's dashboard. This is a data
         integrity boundary, not a nuisance one. */
      await expect(buffer.depth()).resolves.toBe(0);
    });

    it("refuses to serve at all when no token is configured", async () => {
      await app.close();
      app = buildWith({ token: undefined });
      await app.ready();

      const response = await ingest(event(), TOKEN);

      expect(response.statusCode).toBe(503);
      await expect(buffer.depth()).resolves.toBe(0);
    });
  });

  describe("validation", () => {
    it.each([
      ["an empty body", {}],
      ["a missing slug", { id: "e1", ts: 1 }],
      ["a missing id", { slug: "abc1234", ts: 1 }],
      ["a non-numeric timestamp", { id: "e1", slug: "abc1234", ts: "yesterday" }],
      ["a negative timestamp", { id: "e1", slug: "abc1234", ts: -1 }],
      ["an over-long user agent", { id: "e1", slug: "abc1234", ts: 1, userAgent: "U".repeat(600) }],
    ])("rejects %s with 400", async (_label, body) => {
      const response = await ingest(body);

      expect(response.statusCode).toBe(400);
      await expect(buffer.depth()).resolves.toBe(0);
    });

    it("accepts an event with only the required fields", async () => {
      const response = await ingest({ id: "e1", slug: "abc1234", ts: Date.now() });

      /* Cloudflare cannot always determine geo, and a visitor can send no
         User-Agent at all. Neither is a reason to lose the click. */
      expect(response.statusCode).toBe(202);
      await expect(buffer.depth()).resolves.toBe(1);
    });
  });

  describe("enrichment", () => {
    it("carries the edge's facts through unchanged", async () => {
      await ingest(event());

      expect(await bufferedRow()).toMatchObject({
        eventId: "11111111-1111-4111-8111-111111111111",
        slug: "abc1234",
        ts: Date.parse("2026-08-07T10:15:00.000Z"),
        country: "IN",
        city: "Bengaluru",
        timezone: "Asia/Kolkata",
        colo: "BOM",
      });
    });

    it("parses the User-Agent here rather than at the edge", async () => {
      await ingest(event());

      expect(await bufferedRow()).toMatchObject({
        deviceType: "mobile",
        browser: "Safari",
        os: "iOS",
      });
    });

    it("reduces the referrer to its host", async () => {
      const row = await ingest(event()).then(bufferedRow);

      expect(row.referrerHost).toBe("news.ycombinator.com");
    });

    it("does not store the referrer's query string", async () => {
      const row = await ingest(event()).then(bufferedRow);

      /* The referrer carried `token=secret`. A referrer URL routinely leaks
         search terms and session identifiers; only the host is ours to keep. */
      expect(JSON.stringify(row)).not.toContain("secret");
      expect(JSON.stringify(row)).not.toContain("id=42");
    });

    it("fills absent fields with empty strings rather than nulls", async () => {
      await ingest({ id: "e1", slug: "abc1234", ts: Date.now() });

      expect(await bufferedRow()).toMatchObject({
        country: "",
        city: "",
        timezone: "",
        colo: "",
        referrerHost: "",
      });
    });
  });

  describe("the IP", () => {
    it("never reaches the buffered row", async () => {
      const row = await ingest(event()).then(bufferedRow);

      /* The single most important assertion in this file: the address exists for
         the length of one function call and has nowhere to be stored. */
      expect(JSON.stringify(row)).not.toContain(IP);
      expect(Object.keys(row)).not.toContain("ip");
    });

    it("becomes a hash that is stable for the same visitor", async () => {
      await ingest(event({ id: "e1" }));
      await ingest(event({ id: "e2" }));

      const batch = await buffer.drain(10);
      expect(batch.rows[0]?.visitorHash).toBe(batch.rows[1]?.visitorHash);
    });

    it("becomes a different hash for a different visitor", async () => {
      await ingest(event({ id: "e1", ip: IP }));
      await ingest(event({ id: "e2", ip: "198.51.100.4" }));

      const batch = await buffer.drain(10);
      expect(batch.rows[0]?.visitorHash).not.toBe(batch.rows[1]?.visitorHash);
    });

    it("still produces a hash when the edge could not supply one", async () => {
      await ingest({ id: "e1", slug: "abc1234", ts: Date.now() });

      expect((await bufferedRow()).visitorHash).toMatch(/^[0-9a-f]{32}$/);
    });

    it("is never written to the logs", async () => {
      /* Fastify does not log bodies, but the guarantee is worth pinning: a future
         `request.log.info({ body })` would break it silently. */
      const lines: string[] = [];
      const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        lines.push(String(chunk));
        return true;
      });

      try {
        await ingest(event());
      } finally {
        spy.mockRestore();
      }

      expect(lines.join("")).not.toContain(IP);
    });
  });

  describe("backpressure", () => {
    it("reports that a click was buffered", async () => {
      const response = await ingest(event());

      expect(response.json()).toEqual({ status: "buffered" });
    });

    it("still answers 202 when the buffer is full", async () => {
      await app.close();
      const full = new InMemoryClickBuffer(0);
      app = buildWith({ token: TOKEN, buffer: full });
      await app.ready();

      const response = await ingest(event());

      /* The Worker cannot usefully retry, and failing here would only turn a
         dropped row into a logged error at the edge as well. */
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ status: "dropped" });
      await expect(full.droppedTotal()).resolves.toBe(1);
    });
  });

  describe("when the buffer is unreachable", () => {
    it("answers 503 rather than pretending the click landed", async () => {
      await app.close();
      const broken: ClickBuffer = {
        push: () => Promise.reject(new Error("redis is down")),
        drain: () => Promise.resolve({ rows: [], discarded: 0 }),
        ack: () => Promise.resolve(),
        depth: () => Promise.resolve(0),
        droppedTotal: () => Promise.resolve(0),
      };
      app = buildWith({ token: TOKEN, buffer: broken });
      await app.ready();

      const response = await ingest(event());

      /* A silent 202 would make a broken pipeline look exactly like a link nobody
         clicked — the failure mode you discover a week later. */
      expect(response.statusCode).toBe(503);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("upstream_unavailable");
    });
  });

  it.each(["GET", "PUT", "DELETE"])("does not answer %s", async (method) => {
    const response = await app.inject({
      method: method as "GET",
      url: CLICK_INGEST_PATH,
      headers: { "x-internal-token": TOKEN },
    });

    expect(response.statusCode).toBe(404);
  });
});
