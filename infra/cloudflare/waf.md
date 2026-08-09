# Cloudflare edge protection

> **Status: written, not applied.** The Worker has never been deployed and there is
> no zone to apply these to. Everything below is the exact configuration to enter
> when the deploy in Phase 6 happens, kept here so it is a checklist rather than a
> thing to re-derive.

The origin's Redis limiter is precise and expensive: it costs a Redis round trip and
it only runs once a request has already crossed the Atlantic and reached a t3.micro.
Cloudflare's rule is imprecise and free: it runs at the PoP nearest the attacker and
the origin never learns the request happened. They are not redundant — they are the
coarse and fine halves of the same control, and the coarse one is what keeps a flood
from reaching the box the fine one runs on.

## The free-plan constraint

**The free plan allows exactly one rate-limiting rule.** That single rule has to be
spent where the origin's own limiter cannot help, which is the redirect path: a
redirect served from KV never reaches the origin, so no amount of origin-side
limiting can slow down someone enumerating slugs. Link creation already has two
enforced dimensions at the origin; slug enumeration has none.

## Rule 1 (the one free rule) — slug enumeration

Enumerating slugs is the attack the architecture is otherwise most exposed to.
A 7-character base62 slug is a 3.5×10¹² keyspace, so guessing a *specific* link is
hopeless — but harvesting *any* valid links is a different problem, and every guess
is a KV read against a 100k/day quota. A few hours of unthrottled scanning exhausts
the day's reads and the shortener stops working for everyone, without a single link
being compromised. **Quota exhaustion is the realistic damage here, not disclosure.**

| Field | Value |
| --- | --- |
| Name | `slug-enumeration` |
| Expression | `(http.request.uri.path ne "/" and http.response.code eq 404)` |
| Characteristics | IP with NAT support (`cf.unique_visitor_id` when available) |
| Rate | 30 requests |
| Period | 60 seconds |
| Action | Managed Challenge |
| Duration | 60 seconds |

Three choices worth defending:

- **Counting responses, not requests.** A visitor following twenty real short links
  in a minute is normal traffic; a client collecting twenty 404s in a minute is
  scanning. Rate-limiting requests would throttle a popular link's own audience.
- **Managed Challenge, not Block.** A false positive on a shared NAT — an office, a
  university, a mobile carrier — is recoverable by a human and terminal for a
  blocked IP. The attacker's automation fails the challenge either way.
- **A short duration.** The rule exists to make scanning uneconomic, not to punish.
  Sixty seconds resets faster than a human notices and slower than a scanner can
  work.

## If a paid plan ever exists — rules 2 and 3

Written down because they are the ones that were wanted and could not be had, not
because they are planned.

| Name | Expression | Rate | Action |
| --- | --- | --- | --- |
| `create-flood` | `http.request.method eq "POST" and starts_with(http.request.uri.path, "/api/links")` | 30 / 60s | Block |
| `abuse-report-flood` | `http.request.method eq "POST" and http.request.uri.path eq "/api/abuse-reports"` | 20 / 300s | Managed Challenge |

Both duplicate an origin limit on purpose: the origin limit is the correct one and
the edge one exists only so a flood is absorbed before it reaches the origin at all.

## WAF settings that are not rules

These are toggles rather than rules, so the one-rule limit does not apply.

- **Managed Ruleset (Cloudflare Free Managed Rules): on.** Generic injection and
  scanner signatures. Nothing in this API concatenates SQL — DynamoDB and ClickHouse
  are both parameterized — but it costs nothing and catches probes aimed at software
  we are not running.
- **Bot Fight Mode: off on the redirect path.** It challenges anything without a
  browser fingerprint, and a short link is *supposed* to be resolvable by a link
  checker, a chat client's unfurler and a crawler. Turning it on would break the
  primary use case to stop traffic that is already classified as `bot` and stored
  honestly in ClickHouse.
- **Security Level: Medium**, not High. High challenges enough real visitors that a
  short link stops being a thing you can paste into a chat.
- **Browser Integrity Check: off.** Same reasoning as Bot Fight Mode.

## Origin exposure — the setting that makes the per-IP limits real

The origin's per-IP rate limiting is only as trustworthy as `request.ip`, and
`request.ip` is only trustworthy if `X-Forwarded-For` came from something we trust.
See `TRUSTED_PROXIES` in `.env.example`. Two ways to get this right, in order of
preference:

1. **Make the origin unreachable except through Cloudflare.** EC2 security group
   inbound restricted to [Cloudflare's published ranges](https://www.cloudflare.com/ips/),
   `TRUSTED_PROXIES` set to those same ranges. Then a forged `X-Forwarded-For` cannot
   arrive in the first place, and the header can be believed when it does.
2. **Leave `TRUSTED_PROXIES` empty.** `request.ip` becomes the socket peer, which is
   Cloudflare's address for proxied traffic — so all proxied requests share one
   bucket and the per-IP limit degrades into a global one. Wrong, but wrong in the
   safe direction: it over-limits rather than under-limits.

What must never happen is the middle state: `trustProxy: true` with the origin
publicly reachable. Any client that can open a socket to the origin then picks its
own client IP per request, and every per-IP limit in the system is decorative. That
was the configuration before Phase 5.
