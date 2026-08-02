# Infrastructure

## DynamoDB table

`dynamodb-table.json` is a literal `CreateTable` input — no comments, so it works
directly with the AWS CLI (which rejects unknown parameters).

```bash
# DynamoDB Local (docker compose up -d first)
aws dynamodb create-table --cli-input-json file://infra/dynamodb-table.json \
  --endpoint-url http://127.0.0.1:8000

# Real AWS
aws dynamodb create-table --cli-input-json file://infra/dynamodb-table.json
```

No AWS CLI? Use the bundled script, which reads the same JSON and is idempotent:

```bash
pnpm table:create          # local, honours DYNAMODB_ENDPOINT from .env
```

### Capacity — why the numbers look odd

The DynamoDB always-free tier is **25 RCU + 25 WCU for the entire account**, and
**every GSI is provisioned separately on top of the table**. Putting 25/25 on the
table and both indexes would provision 75/75 and start billing immediately.

| Component | RCU | WCU |
|---|---|---|
| Table | 11 | 11 |
| `urlHash-index` (GSI1) | 7 | 7 |
| `owner-index` (GSI2) | 7 | 7 |
| **Total** | **25** | **25** |

Reads skew low deliberately: redirects are served from Workers KV and never reach
DynamoDB on a cache hit, so table reads are cache misses and dashboard queries only.

Two further consequences of the free tier being account-wide:

- **On-demand billing is not covered.** The always-free allowance applies to
  *provisioned* capacity, which is why `BillingMode` is `PROVISIONED`.
- **Any other DynamoDB table on the same account eats the same 25/25.**

### Single-table design

| Access pattern | Key |
|---|---|
| Resolve a slug (the only hot read) | `pk = LINK#<slug>`, `sk = META` |
| Deduplicate on create | GSI1 `gsi1pk = HASH#<urlHash>` |
| List an owner's links, newest first | GSI2 `gsi2pk = USER#<ownerId>`, `gsi2sk = createdAt` |

**GSI1 is `KEYS_ONLY`** — the slug is recoverable from `pk` (`LINK#<slug>`), so
projecting any attribute would add write cost for information already present.

**GSI2 is `INCLUDE`, not `ALL`** — the dashboard list renders four fields; projecting
the rest would pay write capacity on every create for data no query reads.

**`urlHash` is already owner-scoped** (it hashes `ownerId` together with the
canonical URL), so GSI1 needs no sort key to keep one user's links out of another's
dedup results.

### Expiry

`expiresAt` is stored twice: as an ISO-8601 string for the API, and as `ttl`
(epoch **seconds**, which is what DynamoDB TTL requires) for automatic deletion.

TTL is a housekeeping mechanism, **not** the correctness mechanism — AWS only
guarantees deletion within about 48 hours. The application checks expiry on every
read, so an expired link stops redirecting immediately regardless of when the
sweeper gets to it.

Enable TTL once, after the table exists:

```bash
aws dynamodb update-time-to-live --table-name urlgen-links \
  --time-to-live-specification "Enabled=true,AttributeName=ttl"
```

The `table:create` script does this automatically.
