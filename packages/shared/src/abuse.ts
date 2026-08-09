/**
 * Abuse reports.
 *
 * A shortener is an abuse vector by construction: it lends a trustworthy domain to
 * a destination the recipient cannot see before clicking. Safe Browsing catches
 * what Google already knows about at creation time; this is the channel for
 * everything else, including the common case of a link that was clean when it was
 * made and is not any more.
 *
 * The report is deliberately anonymous. Nothing identifying the reporter is
 * accepted, so nothing identifying the reporter can be stored, leaked, or used to
 * retaliate — which also means the endpoint can be fully public without becoming a
 * place personal data accumulates. Abuse of the endpoint itself is handled by rate
 * limiting, not by identifying who sent what.
 */

import { z } from "zod";

import { isWellFormedSlug } from "./slug.js";

/**
 * Why the reporter thinks the link is bad.
 *
 * A closed set rather than free text, because this is the field the review queue
 * sorts and filters on. `details` is where prose goes.
 */
export const abuseReasonSchema = z.enum([
  "malware",
  "phishing",
  "spam",
  "illegal-content",
  "harassment",
  "other",
]);

/** How much free text a report may carry. Enough for context, not for a payload. */
export const MAX_ABUSE_DETAILS_LENGTH = 1_000;

export const abuseReportRequestSchema = z.object({
  /* Shape only — whether the slug exists is never revealed by this endpoint, so
     there is nothing to check it against here. */
  slug: z.string().refine(isWellFormedSlug, "slug is not well formed"),
  reason: abuseReasonSchema,
  details: z.string().trim().max(MAX_ABUSE_DETAILS_LENGTH).optional(),
});

/** A stored report, as the admin endpoints return it. */
export const abuseReportSchema = z.object({
  reportId: z.string(),
  slug: z.string(),
  reason: abuseReasonSchema,
  details: z.string().optional(),
  createdAt: z.string(),
});

/** One entry in the review queue: a slug and how much attention it has attracted. */
export const abuseQueueEntrySchema = z.object({
  slug: z.string(),
  reports: z.number().int().nonnegative(),
  lastReportedAt: z.string(),
});

export type AbuseReason = z.infer<typeof abuseReasonSchema>;
export type AbuseReportRequest = z.infer<typeof abuseReportRequestSchema>;
export type AbuseReport = z.infer<typeof abuseReportSchema>;
export type AbuseQueueEntry = z.infer<typeof abuseQueueEntrySchema>;
