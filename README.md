# URLGen

An edge-resolved URL shortener with real-time click analytics.

Redirects are served from Cloudflare's edge network without touching the origin on a
cache hit, and every click is recorded asynchronously into a columnar analytics store
so tracking never sits on the redirect's critical path.

---

## Why it's built this way

| Concern          | Choice                                          | Reasoning                                                                                                       |
| ---------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Redirect latency | Cloudflare Worker + Workers KV                  | Reads resolve at 300+ points of presence; a single-region database would cross an ocean for half the world      |
| Source of truth  | DynamoDB                                        | Single-key point lookups with conditional writes for lock-free slug allocation                                  |
| Analytics        | ClickHouse                                      | Append-heavy writes and aggregation over time ranges — a workload that would be a full table scan anywhere else |
| Click tracking   | Fire-and-forget → Redis buffer → batched insert | ClickHouse degrades badly on single-row inserts; batching is a requirement, not an optimization                 |

Each storage tier is a cache of the one below it. DynamoDB is the only source of truth.

### Design decisions worth calling out

- **Slugs are random, not sequential.** A counter would need distributed coordination and
  would make links trivially enumerable. Random 7-character base62 (~3.5 × 10¹² values)
  with a DynamoDB conditional write handles collisions without any coordination.
- **Slug generation uses rejection sampling.** 256 is not a multiple of 62, so a naive
  `byte % 62` would make the first eight characters of the alphabet ~1.6× more likely.
  Bytes ≥ 248 are discarded and redrawn, keeping the keyspace uniform.
- **URL canonicalization feeds deduplication only — never the redirect.** The canonical
  form sorts query parameters and strips `utm_*`, which is correct for "is this the same
  link?" and wrong for "where do I send the user?". The original URL is always what's
  stored and served.
- **Deduplication is scoped per owner.** A global dedup would hand one user another
  user's existing slug, leaking their link and its analytics.
- **Analytics store no raw IP addresses** — only a salted, daily-rotating hash for
  unique-visitor estimation, plus coarse geography.

---

## Tech stack

**Edge:** Cloudflare Workers, Workers KV
**Origin:** Node 24, Fastify 5, TypeScript 5.9, Redis, DynamoDB, ClickHouse
**Web:** Next.js 16 (App Router), React 19
**Tooling:** pnpm workspaces, Vitest, ESLint (type-aware), Prettier, Zod

Everything runs within free-tier limits, which shapes the design rather than decorating it.

---

## Getting started

Requires **Node ≥ 22**, **pnpm 11**, and **Docker** (for local Redis / ClickHouse / DynamoDB).

```bash
pnpm install
cp .env.example .env      # every value has a working local default
pnpm services:up          # Redis + ClickHouse + DynamoDB Local
pnpm dev:api              # Fastify  -> http://localhost:3001
pnpm dev:edge             # wrangler -> http://localhost:8787
pnpm dev:web              # Next.js  -> http://localhost:3000
```

Verify a change:

```bash
pnpm verify               # lint + typecheck + test
```

### Configuration

All configuration is read from the environment in exactly one place
(`apps/api/src/config.ts`) and parsed through a Zod schema that fails fast on startup.
Copy `.env.example` and fill it in; `INTERNAL_API_TOKEN` and `VISITOR_HASH_SALT` are
required only when `NODE_ENV=production`.

**Secrets never belong in the repository.** `.env`, `.dev.vars`, and key material are
gitignored. Worker secrets are set with `wrangler secret put`, not in `wrangler.toml`.

---

## Layout

```
apps/
  edge/        Cloudflare Worker — the redirect hot path
  api/         Fastify origin service — writes, source of truth, analytics queries
  web/         Next.js dashboard
packages/
  shared/      Zod schemas, base62 codec, URL canonicalizer, error vocabulary
  config/      Shared TypeScript configuration
```

`packages/shared` is consumed as TypeScript source by all three apps, so a schema change
cannot leave one service behind.

---

## Tests

```bash
pnpm test
```

175 tests cover the shared primitives (base62 round-tripping and sampling uniformity, slug
rules, URL canonicalization, dedup hashing, non-routable-address classification), the API's
configuration loader, link routes with a hostile-URL suite, the Safe Browsing client, and
the DynamoDB repository's slug-allocation retry logic.

DynamoDB integration tests are skipped unless a real endpoint is available:

```bash
pnpm services:up
pnpm table:create
DYNAMODB_TEST_ENDPOINT=http://127.0.0.1:8000 pnpm test
```
