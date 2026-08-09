# URLGen — Threat Model

> Every threat below is mapped to the mitigation that addresses
> it and the test that keeps the mitigation from quietly regressing. A row with no
> test is an admission, not an omission — the ones that have none say so and say why.
>
> **Scope:** this covers the system as built and tested locally. The rows marked
> ⚠️ **deploy-dependent** describe controls that exist only as configuration to be
> applied in Phase 6, and are therefore *not verified*.

---

## What this system is, from an attacker's point of view

Three properties drive everything below.

1. **It lends a trustworthy domain to an untrusted destination.** That is not a bug
   to be fixed; it is the product. Every abuse story starts here.
2. **The hot path never touches the origin.** A redirect served from Workers KV is
   invisible to every origin-side control. Anything that has to be stopped on the
   redirect path has to be stopped at the edge, or not at all.
3. **There is no authentication yet.** Identity is an `x-owner-id` header a caller
   picks for itself. That is a deliberate Phase 1 decision — ownership is in the data
   model from the start so real auth can replace the header and nothing else changes
   — but it means every "per owner" control below is a *resource-fairness* measure,
   not a *security boundary*, until auth lands. Where that distinction matters, it is
   called out in the row.

---

## 1. Abuse of the shortener itself

### 1.1 Laundering an internal address behind a trusted domain

**Threat.** Someone shortens `http://169.254.169.254/latest/meta-data/` or
`http://10.0.0.1/admin` and sends the short link to a victim inside a network where
that resolves. The short domain looks safe; the destination is not.

This is **not** classic SSRF — URLGen never fetches a target URL, so the server is
never the one making the request. Framing it correctly is what keeps the checks
proportionate: the risk is the *laundering*, not the fetch.

**Mitigation.** `packages/shared/src/safety.ts` classifies the hostname as public /
loopback / private / link-local / CGNAT / multicast / reserved / local-hostname, and
only `public` may be shortened. The WHATWG URL parser normalizes most obfuscation for
free (`2130706433`, `0x7f000001`, `0177.0.0.1` and `127.1` all arrive as
`127.0.0.1`); the two things it does not flatten are handled explicitly — IPv4-mapped
IPv6 (`[::ffff:127.0.0.1]` stays hexadecimal, so the embedded v4 is unwrapped and
classified) and a fully-qualified trailing dot (`LOCALHOST.`).

**Tests.** `packages/shared/src/safety.test.ts` —
"rejects obfuscated encodings of loopback, which the URL parser normalizes for us",
"rejects the AWS metadata endpoint", "judges IPv4-mapped IPv6 by the address inside
it", "blocks machine-local hostnames", "blocks bare single-label hosts".

### 1.2 A destination that was clean at creation and is not any more

**Threat.** The realistic pattern. Shorten a benign URL, get it past the create-time
check, distribute the short link, then change what sits at the other end.

**Mitigation.** Two, because neither alone is sufficient.

- **`pnpm rescan`** (`apps/api/src/services/rescan.ts`) re-checks active links against
  Safe Browsing and disables the ones now flagged, overwriting the edge entry with the
  `disabled` tombstone so it stops redirecting immediately. Bounded three ways so it
  cannot exhaust the 10k/day quota or the 25 WCU: a freshness threshold that skips
  recently-checked links, a per-run lookup ceiling, and writes only on links actually
  checked.
- **Abuse reports** (§1.3) catch what Google does not know about.

**Tests.** `apps/api/src/services/rescan.test.ts` — "disables a link that has gone bad
since it was created", "overwrites the edge entry with the disabled tombstone", "never
disables on an `unknown` verdict", "skips links whose verdict is still fresh, spending
no quota on them", "stops at the per-run lookup ceiling and says so", "one failing link
does not end the sweep".

**Known limit, stated rather than hidden.** The re-scan is scheduled, so the window
between a destination going bad and the sweep noticing is up to `staleAfterMs`
(7 days by default). Narrowing it costs Safe Browsing quota linearly. The abuse-report
path is what covers the gap, and it is human-speed.

### 1.3 A malicious link nobody has reported to Google

**Threat.** Phishing aimed at one company, a scam page too new to be listed —
Safe Browsing returns `safe` and it is not.

**Mitigation.** `POST /api/abuse-reports` is public, anonymous and rate limited;
`/admin/abuse` and `/admin/links/:slug/disable` let an operator act on it. The
disable is awaited against the edge and reports failure, because "is this malware
link still live?" has to have a truthful answer.

**Tests.** `apps/api/src/routes/abuse.test.ts`, `apps/api/src/routes/admin.test.ts` —
"disables the link and overwrites the edge entry rather than purging it", "tells the
operator when the change did not reach the edge".

### 1.4 The abuse form used as a slug oracle

**Threat.** The report endpoint must accept a slug from an anonymous caller. If it
answers 404 for an unknown slug, it becomes a free existence check for any candidate.

**Mitigation.** Every well-formed report gets an identical 202 and is stored,
whether or not the slug exists. The existence question is deferred to the admin
reading the queue.

**Test.** `apps/api/src/routes/abuse.test.ts` — "answers identically for a slug that
exists and one that does not" (asserts both the status **and** the body match).

### 1.5 The abuse form used to flood storage

**Threat.** Anonymous unbounded writes into DynamoDB.

**Mitigation.** Per-IP rate limit (10 / 5 min by default), a 1,000-character cap on
the only free-text field, and a 365-day TTL on every report row.

**Tests.** `apps/api/src/http/rate-limit.test.ts` — "refuses a flood of reports from
one address"; `apps/api/src/routes/abuse.test.ts` — "caps the free-text field".

### 1.6 Building a redirect loop, or shadowing a platform route

**Threat.** Shortening the short domain itself; or taking `/api` as a custom slug.

**Mitigation.** `assessUrlSafety({ ownHosts })` rejects self-referential targets;
`RESERVED_SLUGS` blocks platform paths.

**Tests.** `packages/shared/src/safety.test.ts` — "rejects shortening our own domain,
which would build a redirect loop"; `apps/api/src/routes/links.test.ts` — "rejects a
reserved custom slug".

### 1.7 Homograph domains

**Threat.** `аpple.com` with a Cyrillic а.

**Mitigation, and its limit.** Internationalized labels are **flagged, not blocked**.
Every legitimate IDN and every homograph both arrive as `xn--`; telling them apart
needs script-mixing analysis on the decoded label. Blocking would break real IDN
sites. The flag is stored on the record for abuse review.

**Test.** `packages/shared/src/safety.test.ts` — "flags but does not reject
internationalized domains".

**This is a partial mitigation and is recorded as one.** A homograph link is caught
today only if somebody reports it.

---

## 2. Resource exhaustion

### 2.1 Flooding link creation

**Threat.** Creation is the expensive path: two DynamoDB round trips, an outbound
Safe Browsing call, a KV write against a **1,000/day** quota. Unlimited creates
exhaust the day's KV writes long before they exhaust anything else.

**Mitigation.** A Redis sliding-window-log limiter (`rate-limiter.ts`), enforced on
**two dimensions** — per client IP (20 / 60s) and per owner (100 / 3600s). Both must
pass; the headers report whichever is closer to running out.

Two dimensions rather than one, because each alone is trivially defeated: an IP limit
by a proxy pool, an owner limit by picking a new `x-owner-id` per request — which
costs nothing until authentication exists.

The window is a sorted set of request timestamps, not a fixed-window counter. A fixed
window with a limit of 20/minute admits 20 at 11:00:59 and 20 more at 11:01:00, which
is exactly the burst the limit exists to stop.

The check runs **first in the handler**, before validation and before either database
call — a limiter that refuses only after the expensive work has already let the
attacker spend the resource.

**Tests.** `apps/api/src/repositories/rate-limiter.test.ts` — "slides: capacity
returns as the oldest request ages out, not at a bucket boundary", "a refused request
is not recorded, so hammering cannot extend the wait";
`apps/api/src/http/rate-limit.test.ts` — "the per-IP limit is shared across owners",
"the per-owner limit binds even when the IP budget is untouched", "reports the tighter
of the two dimensions, not the looser one";
`apps/api/src/repositories/rate-limiter-integration.test.ts` — "is atomic under
concurrency — 50 simultaneous requests against a limit of 10 admit exactly 10".

**Accepted risk: the limiter fails open.** If Redis cannot answer, the request is
allowed and an error is logged. Refusing every write while Redis is down converts a
cache outage into a full write outage, for a control with a coarser layer above it
(§2.3) and a durable one below (§1.3). What it must never do is fail open *silently*,
which is why there is no in-process fallback limiter — a per-replica limiter would
keep emitting confident `X-RateLimit-*` headers describing a limit nobody enforces.
**Test:** "fails open rather than taking the write path down with Redis" also asserts
no rate-limit headers are sent.

### 2.2 Forging the client address to bypass the per-IP limit

**Threat.** With blanket proxy trust, any client that can open a socket to the origin
sets `X-Forwarded-For` to a fresh address per request and every per-IP limit in the
system is decorative.

**This was a real finding of this phase.** The server ran `trustProxy: true` from
Phase 0, which was harmless while nothing consumed `request.ip` — and became a bypass
the moment per-IP limiting was added on top of it.

**Mitigation.** `trustProxy` is now driven by `TRUSTED_PROXIES`, which defaults to
empty. Empty means `request.ip` is the socket peer, which cannot be forged. In
production it is Cloudflare's published ranges, paired with a security group that
admits only those ranges — see `infra/cloudflare/waf.md`.

⚠️ **Deploy-dependent.** The code change is tested; the correct production value is
documented and unapplied.

### 2.3 Slug enumeration exhausting the KV read quota

**Threat.** Guessing a specific 7-character base62 slug out of 3.5×10¹² is hopeless.
Harvesting *any* valid links is not, and **every guess costs a KV read against a
100k/day quota** — so a few hours of unthrottled scanning takes the shortener down for
everyone without a single link being compromised. Quota exhaustion is the realistic
damage here, not disclosure.

**Mitigation.** Origin-side limiting cannot help: a redirect never reaches the origin.
The single free-plan Cloudflare rate-limiting rule is spent here, counting **404
responses** rather than requests (a popular link's real audience generates 200s;
a scanner generates 404s) and answering with a Managed Challenge rather than a block,
so a shared NAT is recoverable.

At the origin, the parts that can be defended are: `isWellFormedSlug` rejects garbage
paths before spending a KV read, and every lookup miss returns an identical response
(§3.1) so no oracle exists to make scanning efficient.

**Tests.** `apps/edge/src/index.test.ts` — "rejects %s (%s) without spending a KV
read" (bot probes, nested paths, over-long slugs, illegal characters).

⚠️ **Deploy-dependent.** The Cloudflare rule is written in `infra/cloudflare/waf.md`
and has never been applied — there is no zone. **This is the single largest unmitigated
risk in the system as it stands.**

### 2.4 Flooding the click pipeline

**Threat.** Clicks arrive faster than the flusher drains them; Redis grows until the
OOM killer takes the origin — and the redirect path with it.

**Mitigation.** The buffer is capped (`CLICK_BUFFER_MAX`). Past the cap clicks are
dropped and counted rather than queued. Losing analytics is survivable; losing
redirects is not. The cap check and the push are one Lua script, or 50 concurrent
ingests each read a length below the cap before any of them writes.

**Test.** `apps/api/src/repositories/click-buffer-integration.test.ts` — 50 pushes at
a cap of 10 assert depth 10 / dropped 40 (reads 50 without the script).

### 2.5 Oversized request bodies

**Mitigation.** Fastify `bodyLimit` of 16 KB. A link-creation payload is a URL and two
optional fields; anything larger is not one.

---

## 3. Authorization and information disclosure

### 3.1 IDOR — reading someone else's links or analytics

**Threat.** Analytics is where this is most tempting to get wrong, because **click
rows carry no owner column**. The only thing between a guessed slug and someone
else's traffic numbers is an ownership check against DynamoDB.

**Mitigation.** Every owner-facing route resolves ownership against DynamoDB — the
source of truth for who owns what — *before* ClickHouse is touched. "Not yours" and
"does not exist" return the byte-identical 404.

**Tests.** `apps/api/src/routes/analytics.test.ts` — "returns the same 404 for another
owner's link, and never queries it" (asserts the store was never called),
"never asks about another owner's slugs";
`apps/api/src/routes/links.test.ts` — "hides another owner's link behind the same 404
as a missing one", "will not let another owner modify a link", "does not share a slug
across owners".

**⚠️ This is a fairness boundary, not a security boundary, until authentication
exists.** `x-owner-id` is caller-supplied: anyone who knows another owner's id can
present it. The check is correct and will become a real boundary the moment the header
is replaced by an authenticated identity — which is exactly why ownership was put in
the data model in Phase 1 rather than retrofitted.

### 3.2 Internal fields leaking to callers

**Threat.** `urlHash` is a dedup key derived from owner + canonical URL; the Safe
Browsing verdict and its timestamp describe scanner coverage.

**Mitigation.** Responses are built by `linkApiResponseSchema.parse()`, not by
destructuring — Zod strips anything not in the schema, so a future internal field is
dropped unless someone explicitly adds it to the response shape. `linkResponseSchema`
omits `safeBrowsingVerdict` and `verdictCheckedAt`: publishing them would let anyone
with a link probe which URLs have been checked and how stale the check is, and by
inference which destinations are worth trying before the next sweep.

**Tests.** `apps/api/src/routes/links.test.ts` — "never exposes the internal dedup
hash"; `apps/api/src/routes/internal.test.ts` — "leaks nothing internal to the edge".

### 3.3 Errors leaking internals

**Mitigation.** One error vocabulary (`ERROR_CODES`) and one envelope
`{ error: { code, message } }`. Anything ≥500 logs the detail and returns
"Something went wrong". No stack trace, no driver message, no table name reaches a
caller.

**Test.** `apps/api/src/routes/analytics.test.ts` — "returns 503 when ClickHouse is
unavailable, and leaks nothing".

### 3.4 Cross-origin reads of owner-scoped data

**Mitigation.** Hand-rolled allowlist CORS: exact match only, echoed never wildcarded,
`Vary: Origin` always, `/api` only (so the token-bearing Worker endpoints never answer
a preflight), and no credentials.

**Tests.** `apps/api/src/http/cors.test.ts` — "never answers with a wildcard", "does
not echo an origin that is not on the list", "always varies on Origin, allowed or
not", "does not expose the worker's internal endpoints to a page", "is not fooled by a
query string that starts with the api prefix".

### 3.5 A shared cache serving one owner's data to another

**Threat.** Every `/api` response is owner-scoped and the scoping travels in
`x-owner-id` — a *request header no cache keys on*. A shared cache would happily hand
one owner's link list to the next caller of the same URL.

**Mitigation.** `Cache-Control: no-store` on `/api`, plus `Vary: x-owner-id` for any
cache that ignores it. The `Vary` value is **appended** rather than set, because
`reply.header()` replaces and the CORS hook has already written `Origin` there —
the naive one-liner fixes one cache-poisoning problem by creating the other.

**Test.** `apps/api/src/http/security-headers.test.ts` — "varies on x-owner-id WITHOUT
discarding the CORS hook's Origin", "marks /api responses no-store".

---

## 4. Injection

### 4.1 Query injection — DynamoDB, ClickHouse, Redis

**Assessment: structurally absent, not filtered.**

- **DynamoDB** is accessed only through `@aws-sdk/lib-dynamodb` with
  `ExpressionAttributeNames` / `ExpressionAttributeValues`. No expression string is
  ever built from user input; the attribute *names* are literals in the source.
- **ClickHouse** queries use the client's parameter binding. The one place user input
  reaches a query shape at all is the timezone, and it is validated against `Intl`
  before it goes anywhere near the server.
- **Redis** Lua scripts take keys through `KEYS` and values through `ARGV`, which are
  arguments, not concatenation. No script is assembled from a template string.

**Tests.** `apps/api/src/routes/analytics.test.ts` — "rejects an unknown timezone
rather than passing it to ClickHouse". The rest is a code property; the audit is this
row.

### 4.2 XSS

**Threat.** A caller-supplied string reflected into something a browser renders.

**Mitigation, in three layers.**

- The API returns JSON only. The only reflection point is the 404 handler, which
  echoes the requested method and URL into a JSON message.
- `X-Content-Type-Options: nosniff` on every response including errors — without it a
  browser may sniff a body and decide a reflected value makes it HTML, on this API's
  own origin.
- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none';
  form-action 'none'` on every API response.

The Worker's terminal HTML pages are assembled from a **closed record of specs and
never interpolate the request** — the page is safe because there is no interpolation
point, not because the escaping is right.

**Tests.** `apps/api/src/http/security-headers.test.ts` — "sets them on error
responses too"; `apps/edge/src/index.test.ts` — "never echoes the requested path back
into the error page", "locks down the terminal HTML page with a policy that still
permits its own inline style".

### 4.3 Open redirect

**Threat.** The whole product is a redirect, so the defence cannot be "do not
redirect". It has to be "only ever redirect to something that passed the create-time
checks".

**Mitigation.** The Worker **re-validates the target it just read from its own cache**:
`evaluateLink` parses `u` and refuses anything that is not http(s) before emitting a
`Location`. KV is a cache, not a trust boundary — if a bad value ever lands there, the
edge must not be the thing that executes it. A rejected target logs
`link_target_rejected` and serves the ordinary 404: the visitor learns nothing, the
operator learns everything. An unresolvable slug always produces a terminal page,
never a redirect.

**Tests.** `apps/edge/src/link.test.ts`, `apps/edge/src/index.test.ts`.

---

## 5. Secrets and credentials

### 5.1 Secrets in source, logs or responses

**Mitigation.** `config.ts` is the only module that reads `process.env`. `SECRET_KEYS`
drives `redactConfig`, which iterates *the secret list* rather than the config's own
keys — Zod omits absent optional keys entirely, so an unset secret would otherwise
never be visited and redaction would fail open in exactly the untested case.
Config errors carry key names only. Pino redacts `authorization`, `cookie`,
`x-internal-token` and `cf-connecting-ip` from request logs.

**Tests.** `apps/api/src/config.test.ts` — "distinguishes an unset secret from a
redacted one", plus an assertion that a rejected secret value never survives JSON
serialization of the redacted config.

### 5.2 Forged click events

**Threat.** Unauthenticated writes to `/ingest/click` let anyone forge traffic into
another owner's dashboard — a data-integrity problem, not a nuisance.

**Mitigation.** `INTERNAL_API_TOKEN`, compared with `timingSafeEqual` after hashing
both sides to a fixed width (a raw `timingSafeEqual` throws on a length mismatch,
which is itself an oracle for the secret's length). An unconfigured token refuses to
serve rather than serving unauthenticated.

**Tests.** `apps/api/src/routes/ingest.test.ts` — "buffers nothing when the call is
unauthenticated", "refuses to serve at all when no token is configured";
`apps/api/src/routes/internal.test.ts` — "rejects a missing, wrong, or empty token",
"refuses to serve rather than resolving unauthenticated".

### 5.3 The admin surface

**Mitigation.** A **separate** credential (`ADMIN_API_TOKEN`, `x-admin-token`) from the
Worker's, so a leaked service-to-service secret cannot be replayed to disable links.
Same constant-time comparison. When unset, the routes are **not registered at all** —
404, not 401, because a 401 advertises an admin surface and invites someone to look
for the credential.

**Tests.** `apps/api/src/routes/admin.test.ts` — "does not accept the internal token in
place of the admin one", "does not mount the routes at all when no admin token is
configured".

**⚠️ Known limit.** A single shared bearer token is the right size of control for a
one-operator portfolio system and would not be acceptable with more than one operator:
there is no per-admin identity, so the audit log records *that* a link was disabled and
not *by whom*. Recorded rather than pretended otherwise.

---

## 6. Privacy

### 6.1 Visitor IP addresses

**Mitigation — a schema property, not a policy.** There is no IP column in ClickHouse
and a test asserts there is no column whose name even *contains* "ip". The address
exists inside one function call: it arrives in the ingest body, becomes
`HMAC(salt_of_today, ip + ua + slug)`, and is gone.

- **HMAC, not `sha256(ip)`** — the entire IPv4 space is 4 billion values and a laptop
  rainbow-tables it over lunch. The secret salt is what makes it one-way.
- **The salt rotates daily**, in UTC so replicas in different zones agree. A returning
  visitor counts as new tomorrow: a real loss of fidelity, and the point.
- **The hash is scoped to the slug**, so two links owned by the same person cannot be
  joined on `visitor_hash` to follow one person across them. The cost is that "uniques
  across all my links" is not a question this schema can answer.

**Tests.** `apps/api/src/services/visitor-hash.test.ts` — "never emits the IP or the
User-Agent it was given", "is not a bare digest of the inputs", "rotates the salt
daily, so yesterday's hash cannot be reproduced", "scopes the hash to the slug so two
links cannot be joined on it"; `apps/api/src/routes/ingest.test.ts` — "never reaches
the buffered row", "is never written to the logs".

### 6.2 Referrer leakage

**Threat, in both directions.** A referrer URL routinely carries search terms, session
identifiers and document titles. And the short URL itself is a secret-ish token that
should not be handed to every destination in full.

**Mitigation.** Inbound: the referrer is reduced to a **host** before anything stores
it. Outbound: `Referrer-Policy: strict-origin-when-cross-origin` on the redirect — the
destination learns it was reached from the short domain and never learns the slug.

Deliberately *not* `no-referrer` at the edge, unlike the API: stripping the referrer
entirely would break the referrer analytics of every site anyone shortens a link to.

**Tests.** `apps/api/src/routes/ingest.test.ts` — "does not store the referrer's query
string"; `apps/edge/src/index.test.ts` — "keeps the referrer at origin granularity on a
redirect, never the full short URL".

### 6.3 Reporter identity

**Mitigation.** Abuse reports record nothing about the reporter — no IP, no hash of
one, no header echo. A class of problem removed rather than mitigated: there is no
retaliation risk in the data because the data does not exist. The rate limiter needs
the address for the moments it takes to decide and never writes it down.

**Test.** `apps/api/src/routes/abuse.test.ts` — "stores nothing identifying the
reporter" (asserts over the whole serialized report).

---

## 7. Availability of the redirect path

**The property the whole design protects:** analytics, the click buffer, the abuse
pipeline and the origin itself can all be down without a cached redirect noticing.

- Click tracking is `ctx.waitUntil()`, after the 302 has been written. Verified live
  in Phase 3: with the origin process killed, a cached slug still returned **302 in
  8ms** while the click POST timed out in the background.
- Edge cache sync failures never fail the owner's request (the source of truth has
  already changed; failing would tell them their edit did not happen when it did).
  The **one** exception is the admin disable, which reports the failure because an
  operator can act on it.
- The analytics cache degrades to a no-op.
- The rate limiter fails open (§2.1).

**Tests.** `apps/edge/src/index.test.ts` origin-failure block;
`apps/api/src/routes/links.test.ts` — "still reports a successful create/update/delete"
when the edge cache throws.

---

## Summary — what is unmitigated

| # | Gap | Why |
| --- | --- | --- |
| 1 | **The Cloudflare rate-limiting rule is not applied** (§2.3) | No deploy, no zone. Slug enumeration is throttled by nothing today. Largest open risk. |
| 2 | **`x-owner-id` is self-asserted** (§3.1) | No authentication yet, by design. Every owner-scoped check is fairness, not security, until it lands. |
| 3 | **Homographs are flagged, not blocked** (§1.7) | Blocking would break real IDN sites. Caught only if reported. |
| 4 | **Re-scan latency is up to 7 days** (§1.2) | Narrowing it costs Safe Browsing quota linearly. |
| 5 | **One shared admin token, no per-admin identity** (§5.3) | Audit records what happened, not who did it. |
| 6 | **`TRUSTED_PROXIES` correctness is deploy-dependent** (§2.2) | The safe default is applied and tested; the production value is documented and unapplied. |
