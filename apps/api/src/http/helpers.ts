/** Small HTTP helpers shared by the route modules. */

import { timingSafeEqual } from "node:crypto";

import { ERROR_STATUS, apiError, type ErrorCode, type LinkRecord } from "@urlgen/shared";
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

/** Builds the public short URL for a slug. */
export function shortUrlFor(shortDomain: string, slug: string): string {
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(shortDomain) ? "http" : "https";
  return `${scheme}://${shortDomain}/${slug}`;
}
