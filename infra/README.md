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

| Component              | RCU    | WCU    |
| ---------------------- | ------ | ------ |
| Table                  | 11     | 11     |
| `urlHash-index` (GSI1) | 7      | 7      |
| `owner-index` (GSI2)   | 7      | 7      |
| **Total**              | **25** | **25** |

Reads skew low deliberately: redirects are served from Workers KV and never reach
DynamoDB on a cache hit, so table reads are cache misses and dashboard queries only.

Two further consequences of the free tier being account-wide:

- **On-demand billing is not covered.** The always-free allowance applies to
  _provisioned_ capacity, which is why `BillingMode` is `PROVISIONED`.
- **Any other DynamoDB table on the same account eats the same 25/25.**

### Single-table design

| Access pattern                      | Key                                                       |
| ----------------------------------- | --------------------------------------------------------- |
| Resolve a slug (the only hot read)  | `pk = LINK#<slug>`, `sk = META`                           |
| Deduplicate on create               | GSI1 `gsi1pk = HASH#<urlHash>`                            |
| List an owner's links, newest first | GSI2 `gsi2pk = USER#<ownerId>`, `gsi2sk = createdAt`      |
| Abuse reports for one link          | `pk = LINK#<slug>`, `sk begins_with REPORT#` *(Phase 5)*  |
| Re-scan every active link           | table `Scan`, filtered `sk = META AND status = active`    |

**Abuse reports live in the link's own partition** rather than a partition of their
own, so "everything about this slug" is one Query against a partition that already
exists. Their sort key is `REPORT#<createdAt>#<reportId>` — the id is part of the
key, not just an attribute, because two reports filed in the same millisecond would
otherwise be one overwriting the other, and a burst is the normal shape of a real
report. They carry the same `ttl` attribute as links, set to 365 days.

Report items have **no `gsi1pk` or `gsi2pk`**, so they never appear in either index —
DynamoDB GSIs are sparse. That is what keeps the dedup lookup and the owner listing
from having to filter them out. The table scan is the one place that *does* have to:
`sk = META` is in the filter for exactly that reason, and without it the scan returns
report items and the record parser throws on the first one — a failure that only
appears once a link has actually been reported.

**The review queue ("which slugs need looking at") is deliberately not in DynamoDB.**
Answering it here would need a third GSI, and the capacity table above is already
exactly 25/25 — a third index means re-cutting all three. For a queue that holds a
handful of slugs and can be rebuilt from the reports, a Redis sorted set is the right
size of tool. Losing Redis loses the queue, not the reports.

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
