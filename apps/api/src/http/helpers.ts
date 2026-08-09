/** Small HTTP helpers shared by the route modules. */

import { timingSafeEqual } from "node:crypto";

import {
  ERROR_STATUS,
  apiError,
  type ErrorCode,
  type KvLinkValue,
  type LinkRecord,
  type LinkSummary,
} from "@urlgen/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Placeholder identity.
 *
 * Phase 1 has no authentication, but ownership is baked into the data model from
 * the start (dedup is owner-scoped, links list per owner) because retrofitting it
 * later would mean rewriting the keys. Real authentication replaces this header;
 * nothing else has to change.
 */
const OWNER_HEADER = "x-owner-id";
const DEFAULT_OWNER = "public";
const OWNER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function resolveOwnerId(request: FastifyRequest): string {
  const header = request.headers[OWNER_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && OWNER_PATTERN.test(value) ? value : DEFAULT_OWNER;
}

/** Sends the standard error envelope with the status mapped from the code. */
export function sendError(reply: FastifyReply, code: ErrorCode, message: string): FastifyReply {
  return reply.code(ERROR_STATUS[code]).send(apiError(code, message));
}

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be an oracle
 * for the secret's length — so both sides are hashed to a fixed width first.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    /* Still do the comparison so the failure path costs roughly the same. */
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Header the Worker authenticates its service-to-service calls with. */
export const INTERNAL_TOKEN_HEADER = "x-internal-token";

/** Header the abuse-review endpoints are authenticated with. */
export const ADMIN_TOKEN_HEADER = "x-admin-token";

export type InternalAuthResult = "ok" | "not-configured" | "invalid";

/**
 * Authenticates a call from the edge worker.
 *
 * Shared by every `/internal` and `/ingest` route so the comparison is written
 * once — a second hand-rolled copy is how one endpoint ends up with a `===` and a
 * timing oracle nobody notices.
 *
 * Returns a result rather than sending a reply so the caller decides what a
 * failure means for its own path: an unconfigured token is a deployment fault
 * worth logging loudly, and each route logs it in its own words.
 */
export function verifyInternalToken(
  request: FastifyRequest,
  expectedToken: string | undefined,
): InternalAuthResult {
  return verifyToken(request, INTERNAL_TOKEN_HEADER, expectedToken);
}

/**
 * Authenticates an abuse-review call.
 *
 * Same comparison as the Worker's, different header, so a leaked internal token
 * cannot be replayed against the admin surface and vice versa. One credential
 * doing both jobs is how a service-to-service secret ends up granting
 * administrative rights.
 */
export function verifyAdminToken(
  request: FastifyRequest,
  expectedToken: string | undefined,
): InternalAuthResult {
  return verifyToken(request, ADMIN_TOKEN_HEADER, expectedToken);
}

function verifyToken(
  request: FastifyRequest,
  header: string,
  expectedToken: string | undefined,
): InternalAuthResult {
  if (expectedToken === undefined) {
    return "not-configured";
  }

  const raw = request.headers[header];
  const provided = Array.isArray(raw) ? raw[0] : raw;

  if (typeof provided !== "string" || !secretsMatch(provided, expectedToken)) {
    return "invalid";
  }

  return "ok";
}

/** True when the link has an expiry that has already passed. */
export function isExpired(
  record: Pick<LinkRecord, "expiresAt">,
  now: number = Date.now(),
): boolean {
  return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now;
}

/**
 * True when the link should still redirect.
 *
 * Expiry is evaluated here on every read rather than trusted to DynamoDB's TTL
 * sweeper, which AWS only promises to run within about 48 hours.
 */
export function isResolvable(record: LinkRecord, now: number = Date.now()): boolean {
  return record.status === "active" && !isExpired(record, now);
}

/**
 * Projects a stored record onto the compact blob the edge caches.
 *
 * Single-character keys because this value is read on every redirect. Nothing
 * internal — owner, dedup hash, click count — crosses into it: KV is readable by
 * anything with the namespace binding, and the edge needs none of it.
 */
export function toKvLinkValue(record: LinkRecord | LinkSummary): KvLinkValue {
  return {
    u: record.targetUrl,
    s: record.status,
    ...(record.expiresAt !== undefined ? { e: Date.parse(record.expiresAt) } : {}),
  };
}

/** Builds the public short URL for a slug. */
export function shortUrlFor(shortDomain: string, slug: string): string {
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(shortDomain) ? "http" : "https";
  return `${scheme}://${shortDomain}/${slug}`;
}
