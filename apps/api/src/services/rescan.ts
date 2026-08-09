/**
 * Re-checking links that were already accepted.
 *
 * The create-time Safe Browsing lookup answers "is this URL known-bad *now*",
 * which is the wrong tense for a shortener. The realistic abuse pattern is not
 * shortening a URL Google already flags — it is shortening a clean URL, waiting
 * for the short link to be distributed, and then changing what sits at the other
 * end. Nothing on the create path can see that happen, so it has to be looked for
 * afterwards.
 *
 * ## Budgets shape the design
 *
 * Safe Browsing allows 10k lookups a day and the table's write capacity is 25 WCU,
 * shared with everything else. So a sweep is bounded three ways:
 *
 * - **Freshness.** A link whose verdict is younger than `staleAfterMs` is skipped
 *   entirely — no lookup, no write. Without this, every run re-checks every link
 *   and the quota is spent on answers we already have.
 * - **A per-run ceiling.** `maxChecks` caps the lookups one invocation can make,
 *   so a schedule that fires more often than expected cannot exhaust the day's
 *   quota in one go. The sweep resumes from a different set of links next time,
 *   because the freshest ones are the ones now being skipped.
 * - **Writes only when there is something to say.** A verdict is written back on
 *   every *checked* link, because "when did we last look" is the state the
 *   freshness rule reads — but links that were skipped are never written.
 *
 * ## Only `malicious` acts
 *
 * `unknown` is what a timeout, a missing key or an unparseable response produces,
 * and it must not disable anyone's link. This is the same fail-open posture as the
 * create path, for the same reason: making Google's availability our availability
 * is a worse outcome than a slower reaction to a bad link, which the abuse-report
 * path also catches.
 */

import type { LinkRecord } from "@urlgen/shared";

import type { EdgeCache } from "../repositories/edge-cache.js";
import type { LinkRepository } from "../repositories/link-repository.js";
import { toKvLinkValue } from "../http/helpers.js";
import type { UrlSafetyChecker } from "./safe-browsing.js";

/** Just enough logging surface to run outside Fastify. */
export interface RescanLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface RescanOptions {
  repository: LinkRepository;
  checker: UrlSafetyChecker;
  edgeCache: EdgeCache;
  logger: RescanLogger;
  /** Skip links checked more recently than this. Defaults to 7 days. */
  staleAfterMs?: number;
  /** Hard ceiling on Safe Browsing lookups for this run. Defaults to 500. */
  maxChecks?: number;
  /** Rows per scan page. Defaults to 100. */
  pageSize?: number;
  now?: () => Date;
}

export interface RescanSummary {
  scanned: number;
  checked: number;
  skippedFresh: number;
  disabled: number;
  errors: number;
}

const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CHECKS = 500;
const DEFAULT_PAGE_SIZE = 100;

/** Re-checks active links and disables the ones Safe Browsing now flags. */
export async function rescanLinks(options: RescanOptions): Promise<RescanSummary> {
  const { repository, logger } = options;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const maxChecks = options.maxChecks ?? DEFAULT_MAX_CHECKS;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const clock = options.now ?? (() => new Date());

  const summary: RescanSummary = {
    scanned: 0,
    checked: 0,
    skippedFresh: 0,
    disabled: 0,
    errors: 0,
  };

  let cursor: string | undefined;

  do {
    const page = await repository.scanActive({
      limit: pageSize,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    cursor = page.cursor;

    for (const record of page.items) {
      summary.scanned += 1;

      if (isFresh(record, clock().getTime(), staleAfterMs)) {
        summary.skippedFresh += 1;
        continue;
      }

      if (summary.checked >= maxChecks) {
        /* Stop looking up, but keep walking the page counter so the summary
           reports how much was left — an operator needs to know the sweep did not
           finish, not just that it stopped. */
        continue;
      }

      summary.checked += 1;

      try {
        await checkOne(record, options, clock().toISOString(), summary);
      } catch (error) {
        /* One bad link must not end the sweep: the next one may be the malicious
           one this run exists to find. */
        summary.errors += 1;
        logger.error({ err: error, slug: record.slug }, "rescan failed for a link");
      }
    }
  } while (cursor !== undefined && summary.checked < maxChecks);

  logger.info({ ...summary }, "safe browsing rescan finished");

  if (summary.checked >= maxChecks) {
    logger.warn(
      { maxChecks },
      "rescan hit its per-run lookup ceiling — some links were not checked",
    );
  }

  return summary;
}

async function checkOne(
  record: LinkRecord,
  options: RescanOptions,
  checkedAt: string,
  summary: RescanSummary,
): Promise<void> {
  const { repository, checker, edgeCache, logger } = options;

  const verdict = await checker.check(record.targetUrl);

  if (verdict !== "malicious") {
    await repository.update(record.slug, {
      safeBrowsingVerdict: verdict,
      verdictCheckedAt: checkedAt,
    });
    return;
  }

  const updated = await repository.update(record.slug, {
    status: "disabled",
    safeBrowsingVerdict: verdict,
    verdictCheckedAt: checkedAt,
  });
  summary.disabled += 1;

  /* Overwrite, not purge — same reasoning as the admin disable path: a link that
     has just been found malicious is the one most likely to be under active
     traffic, and a `disabled` tombstone answers those hits at the edge instead of
     converting every one of them into an origin round trip. */
  try {
    await edgeCache.put(record.slug, toKvLinkValue(updated));
  } catch (error) {
    /* Counted and logged, never rethrown. The link is disabled in the source of
       truth, so a cache miss already resolves correctly; what is at risk is only
       the entry cached before the change, and that is bounded by the backstop TTL. */
    summary.errors += 1;
    logger.error({ err: error, slug: record.slug }, "disabled link did not reach the edge");
  }

  /* The one line an operator should have an alert on. The URL is logged because
     this is an operational record of a decision made about a specific
     destination — an incident, not routine traffic. */
  logger.warn(
    { event: "link_disabled_by_rescan", slug: record.slug, targetUrl: record.targetUrl },
    "safe browsing now flags a previously accepted link — disabled",
  );
}

/** True when the stored verdict is recent enough that re-checking would be waste. */
function isFresh(record: LinkRecord, nowMs: number, staleAfterMs: number): boolean {
  if (record.verdictCheckedAt === undefined) {
    return false;
  }
  const checkedAtMs = Date.parse(record.verdictCheckedAt);
  return !Number.isNaN(checkedAtMs) && nowMs - checkedAtMs < staleAfterMs;
}
