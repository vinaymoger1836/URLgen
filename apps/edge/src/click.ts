/**
 * Click tracking — the part of the Worker the visitor never waits for.
 *
 * Three rules govern everything in this file:
 *
 * 1. **It runs inside `ctx.waitUntil()`, after the 302 has already gone out.**
 *    The redirect must never fail because analytics failed.
 * 2. **It does no parsing.** `request.cf` fields are copied, the User-Agent is
 *    sliced, and that is all. Deriving device/browser/OS from a UA string is
 *    regex-heavy work that would eat a meaningful slice of the 10ms CPU budget on
 *    every single redirect, so it happens at the origin where there is no ceiling.
 * 3. **Every failure is swallowed.** A lost click is a missing row in a chart. An
 *    exception escaping `waitUntil` is an error in the logs for every visitor of
 *    a link whose origin happens to be down.
 *
 * Note on the architecture this creates: the origin now receives one asynchronous
 * POST per click, so "the origin only sees cache misses" is true of *synchronous*
 * traffic only. That is the trade this design accepts — Cloudflare Queues would
 * remove it, and Queues is not on the free plan.
 */

import {
  CLICK_INGEST_PATH,
  MAX_REFERRER_LENGTH,
  MAX_USER_AGENT_LENGTH,
  type ClickEvent,
} from "@urlgen/shared";

import type { Env } from "./env.js";
import { describeError, logWarn } from "./log.js";

/**
 * How long to wait on the ingest endpoint.
 *
 * Shorter than the resolve timeout because nobody is waiting on this: the only
 * thing a longer budget buys is a Worker invocation held open against the CPU and
 * duration limits for a request whose answer is discarded either way.
 */
const INGEST_TIMEOUT_MS = 1500;

/**
 * Builds the event for a redirect that has just been served.
 *
 * Separated from sending so it stays a pure function of the request — which is
 * what makes it testable without a network, and what keeps the sending path down
 * to a single `fetch`.
 */
export function buildClickEvent(request: Request, slug: string, now: number): ClickEvent {
  const cf = request.cf;

  return {
    /* Minted here, at the one point in the pipeline that happens exactly once per
       click. Anything downstream — a retried flush above all — can be replayed;
       this cannot. */
    id: crypto.randomUUID(),
    slug,
    ts: now,
    ...optional("country", stringField(cf?.country)),
    ...optional("city", stringField(cf?.city)),
    ...optional("timezone", stringField(cf?.timezone)),
    ...optional("colo", stringField(cf?.colo)),
    ...optional("userAgent", truncate(request.headers.get("user-agent"), MAX_USER_AGENT_LENGTH)),
    ...optional("referrer", truncate(request.headers.get("referer"), MAX_REFERRER_LENGTH)),
    /* The visitor's IP, for exactly one hop. The origin turns it into a salted
       daily hash and drops it; it is never stored and never logged. Cloudflare's
       own header is the authority here — anything client-supplied is forgeable. */
    ...optional("ip", stringField(request.headers.get("cf-connecting-ip"))),
  };
}

/**
 * Posts a click to the origin. Never throws.
 *
 * Pass the returned promise to `ctx.waitUntil()`; awaiting it on the request path
 * would put the origin's latency back into a redirect that had already escaped it.
 */
export async function trackClick(env: Env, event: ClickEvent): Promise<void> {
  const token = env.INTERNAL_API_TOKEN;
  if (token === undefined || token === "") {
    /* Already reported loudly by the resolve path on the first cache miss. Warn
       once here too, without the noise of an error per click. */
    logWarn("click_token_missing", { slug: event.slug });
    return;
  }

  const url = `${env.ORIGIN_API_BASE.replace(/\/+$/, "")}${CLICK_INGEST_PATH}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": token,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      logWarn("click_ingest_rejected", { slug: event.slug, status: response.status });
    }

    /* Draining the body lets the connection be reused for the next click instead
       of being torn down. */
    await response.body?.cancel();
  } catch (error) {
    logWarn("click_ingest_failed", { slug: event.slug, error: describeError(error) });
  }
}

/**
 * Builds `{ key: value }` or `{}`.
 *
 * `exactOptionalPropertyTypes` makes `{ city: undefined }` a different type from
 * an absent `city`, and the schema on the other side treats them differently too —
 * spreading an empty object is how an absent field stays genuinely absent.
 */
function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** Narrows a `request.cf` field, which the runtime types as `unknown`-ish. */
function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Caps a header at the origin's schema bound.
 *
 * Truncating rather than dropping: a client sending a 4KB User-Agent is unusual,
 * not malicious enough to be worth losing the click over, and the first 512 bytes
 * still classify correctly.
 */
function truncate(value: string | null, max: number): string | undefined {
  if (value === null || value === "") {
    return undefined;
  }
  return value.length > max ? value.slice(0, max) : value;
}
