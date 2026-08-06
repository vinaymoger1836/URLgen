/**
 * The cache-miss path: ask the origin what a slug resolves to.
 *
 * This is the only thing the Worker can do that leaves Cloudflare's network, so it
 * is also the only thing that can be slow. Everything here is written on the
 * assumption that the origin may be down, slow, or misconfigured, and that a
 * visitor must still get a defined answer either way.
 */

import { kvLinkValueSchema, type KvLinkValue } from "@urlgen/shared";

import type { Env } from "./env.js";
import { describeError, logError, logWarn } from "./log.js";

/**
 * How long to wait on the origin before giving up.
 *
 * A visitor staring at a blank tab is worse than a fast, honest "try again". The
 * budget is generous enough for a cross-continent round trip to EC2 and short
 * enough that nobody waits on a box that is not answering.
 */
const ORIGIN_TIMEOUT_MS = 2500;

export type OriginResolution =
  | { kind: "found"; value: KvLinkValue }
  | { kind: "missing" }
  | { kind: "gone"; reason: "expired" | "disabled" }
  | { kind: "unavailable" };

/** Fetches a slug's compact blob from the origin's internal resolve endpoint. */
export async function resolveFromOrigin(env: Env, slug: string): Promise<OriginResolution> {
  const token = env.INTERNAL_API_TOKEN;
  if (token === undefined || token === "") {
    /* A deployment fault, not a visitor's problem: without the token the origin
       will reject every miss, so say so loudly once per miss rather than pretend
       the link does not exist. */
    logError("origin_token_missing", { slug });
    return { kind: "unavailable" };
  }

  const url = `${env.ORIGIN_API_BASE.replace(/\/+$/, "")}/internal/resolve/${encodeURIComponent(slug)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { "x-internal-token": token, accept: "application/json" },
      signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
    });
  } catch (error) {
    logWarn("origin_unreachable", { slug, error: describeError(error) });
    return { kind: "unavailable" };
  }

  if (response.status === 200) {
    return await readBlob(response, slug);
  }

  if (response.status === 404) {
    return { kind: "missing" };
  }

  if (response.status === 410) {
    return { kind: "gone", reason: await readGoneReason(response) };
  }

  if (response.status === 401 || response.status === 403) {
    logError("origin_rejected_token", { slug, status: response.status });
    return { kind: "unavailable" };
  }

  logWarn("origin_unexpected_status", { slug, status: response.status });
  return { kind: "unavailable" };
}

/** Parses the 200 body, treating anything unexpected as an origin failure. */
async function readBlob(response: Response, slug: string): Promise<OriginResolution> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    logWarn("origin_body_unparseable", { slug, error: describeError(error) });
    return { kind: "unavailable" };
  }

  const parsed = kvLinkValueSchema.safeParse(body);
  if (!parsed.success) {
    /* The two services share this schema, so a mismatch means they are on
       different versions — worth an error, not a silent 404. */
    logError("origin_body_invalid", { slug });
    return { kind: "unavailable" };
  }

  return { kind: "found", value: parsed.data };
}

/**
 * Distinguishes the two 410s.
 *
 * Both render as a terminal page, so a body we cannot read is not fatal — it just
 * costs the visitor slightly less specific wording.
 */
async function readGoneReason(response: Response): Promise<"expired" | "disabled"> {
  try {
    const body: unknown = await response.json();
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
    return code === "link_disabled" ? "disabled" : "expired";
  } catch {
    return "expired";
  }
}
