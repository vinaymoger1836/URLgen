/**
 * Zod schemas shared across the edge worker, the API and the web app.
 *
 * Every boundary parses through these — HTTP bodies, KV values, and the internal
 * resolve contract. One definition means the three services cannot drift apart.
 */

import { z } from "zod";

import { validateCustomSlug, type SlugRejectionReason } from "./slug.js";
import { ALLOWED_PROTOCOLS, MAX_URL_LENGTH, parseUrl } from "./url.js";

const SLUG_REJECTION_MESSAGES: Readonly<Record<SlugRejectionReason, string>> = {
  "too-short": "slug must be at least 3 characters",
  "too-long": "slug must be at most 32 characters",
  "invalid-characters": "slug may only contain letters, digits, hyphen and underscore",
  "leading-or-trailing-separator": "slug may not start or end with a hyphen or underscore",
  reserved: "slug is reserved by the platform",
};

/**
 * A URL we are willing to shorten.
 *
 * Phase 0 covers the structural rules. Network-level defences (private-range and
 * metadata-endpoint blocking, Safe Browsing lookups) land in Phase 1, where the
 * API can resolve hostnames and call out.
 */
export const targetUrlSchema = z
  .string()
  .trim()
  .min(1, "url is required")
  .max(MAX_URL_LENGTH, `url must be at most ${MAX_URL_LENGTH} characters`)
  .superRefine((value, ctx) => {
    const url = parseUrl(value);
    if (!url) {
      ctx.addIssue({ code: "custom", message: "url must be a valid absolute URL" });
      return;
    }
    if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
      ctx.addIssue({ code: "custom", message: "url must use http or https" });
    }
    if (url.username !== "" || url.password !== "") {
      ctx.addIssue({ code: "custom", message: "url must not embed credentials" });
    }
    if (url.hostname === "") {
      ctx.addIssue({ code: "custom", message: "url must include a hostname" });
    }
  });

export const customSlugSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    const result = validateCustomSlug(value);
    if (!result.valid) {
      ctx.addIssue({ code: "custom", message: SLUG_REJECTION_MESSAGES[result.reason] });
    }
  });

/** An absolute point in time, accepted as an ISO-8601 string. */
export const timestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-8601 timestamp");

/**
 * `disabled` is an administrative action (abuse), `deleted` is the owner removing
 * their own link. Both are soft — the row stays so the slug is never recycled and
 * historical analytics keep resolving.
 */
export const linkStatusSchema = z.enum(["active", "disabled", "expired", "deleted"]);

export const createLinkRequestSchema = z.object({
  url: targetUrlSchema,
  customSlug: customSlugSchema.optional(),
  expiresAt: timestampSchema.optional(),
});

export const linkRecordSchema = z.object({
  slug: z.string(),
  targetUrl: z.string(),
  ownerId: z.string(),
  status: linkStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  expiresAt: timestampSchema.optional(),
  urlHash: z.string(),
  clickCount: z.number().int().nonnegative(),
  /** Set when the target hostname is internationalized — surfaced for abuse review. */
  punycode: z.boolean().optional(),
});

/**
 * A link without its dedup hash.
 *
 * This is what a listing can return: the owner index projects only the attributes
 * the listing reads, and `urlHash` is deliberately not among them — paying GSI
 * write capacity to carry a hash no query reads would be waste. It is also exactly
 * what the API hands back, since the hash is internal bookkeeping either way.
 */
export const linkSummarySchema = linkRecordSchema.omit({ urlHash: true });

/** What the API returns to a caller: the record minus internal bookkeeping. */
export const linkResponseSchema = linkSummarySchema;

export const updateLinkRequestSchema = z
  .object({
    url: targetUrlSchema.optional(),
    expiresAt: timestampSchema.nullable().optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    "at least one field must be provided",
  );

/**
 * The compact blob stored in Workers KV.
 *
 * Field names are single characters because this value is read on every redirect;
 * the shorter the payload, the less there is to transfer and parse in the Worker's
 * 10ms CPU budget.
 */
export const kvLinkValueSchema = z.object({
  /** target url */
  u: z.string(),
  /** expiry, epoch milliseconds; absent means it never expires */
  e: z.number().int().positive().optional(),
  /** status */
  s: linkStatusSchema,
});

export type CreateLinkRequest = z.infer<typeof createLinkRequestSchema>;
export type UpdateLinkRequest = z.infer<typeof updateLinkRequestSchema>;
export type LinkRecord = z.infer<typeof linkRecordSchema>;
export type LinkSummary = z.infer<typeof linkSummarySchema>;
export type LinkResponse = z.infer<typeof linkResponseSchema>;
export type LinkStatus = z.infer<typeof linkStatusSchema>;
export type KvLinkValue = z.infer<typeof kvLinkValueSchema>;
