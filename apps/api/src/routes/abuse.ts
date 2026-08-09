/**
 * Abuse reporting — the public half.
 *
 * One endpoint, and almost all of its design is about what it does *not* say.
 *
 * **It answers 202 for every well-formed report, whether or not the slug exists.**
 * The tempting alternative — 404 for an unknown slug — turns the abuse form into a
 * slug oracle: an attacker submits reports for candidate slugs and reads existence
 * off the status code, at no cost and against an endpoint that has to stay open to
 * anonymous callers. So the response is identical either way, and the existence
 * check happens later, when an admin looks at the queue.
 *
 * **It records nothing about the reporter.** No IP, no hash of one, no header
 * echo. That removes a class of problem entirely rather than mitigating it: there
 * is no retaliation risk in the data because the data does not exist, and the
 * endpoint cannot quietly become a place personal information accumulates. Abuse
 * *of* the form is handled by the rate limiter, which needs the address only for
 * the moments it takes to make a decision and never writes it down.
 */

import { abuseReportRequestSchema } from "@urlgen/shared";
import type { FastifyInstance } from "fastify";

import type { Config } from "../config.js";
import { clientIp, enforceRateLimit } from "../http/rate-limit.js";
import { sendError } from "../http/helpers.js";
import type { AbuseQueue, AbuseRepository } from "../repositories/abuse-repository.js";
import type { RateLimiter } from "../repositories/rate-limiter.js";

export interface AbuseRoutesOptions {
  config: Config;
  reports: AbuseRepository;
  queue: AbuseQueue;
  rateLimiter: RateLimiter;
  /** Injectable for deterministic tests. */
  now?: () => Date;
}

export function registerAbuseRoutes(app: FastifyInstance, options: AbuseRoutesOptions): void {
  const { config, reports, queue, rateLimiter } = options;
  const clock = options.now ?? (() => new Date());

  app.post("/api/abuse-reports", async (request, reply) => {
    const allowed = await enforceRateLimit(request, reply, rateLimiter, [
      {
        dimension: "report:ip",
        identity: clientIp(request),
        rule: {
          limit: config.RATE_LIMIT_REPORT_PER_IP,
          windowMs: config.RATE_LIMIT_REPORT_PER_IP_WINDOW_SECONDS * 1000,
        },
      },
    ]);
    if (!allowed) {
      return reply;
    }

    const parsed = abuseReportRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid body");
    }

    const { slug, reason, details } = parsed.data;

    try {
      const report = await reports.record({ slug, reason, ...(details !== undefined ? { details } : {}) });
      await queue.add(slug, clock());

      /* The notification channel, until there is a real one. `details` is
         deliberately not logged — it is free text from an anonymous stranger and
         the one field in this request that could carry anything at all. */
      request.log.warn(
        { event: "abuse_report_received", slug, reason, reportId: report.reportId },
        "abuse report received",
      );
    } catch (error) {
      request.log.error({ err: error, slug }, "could not record an abuse report");
      return sendError(reply, "upstream_unavailable", "Could not record the report");
    }

    /* Identical for a real slug and an invented one. */
    return reply.code(202).send({ status: "received" });
  });
}
