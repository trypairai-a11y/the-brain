# Operations contract

The Brain exposes a contract-first operations layer for agents (FAI) and dashboards.
Every operation is defined once in `apps/api/src/ops/operations.ts` (name, scope,
Zod params, handler); `apps/api/src/routes/ops.ts` dispatches it over REST. An MCP
surface can be generated from the same registry later.

## Endpoints

```
GET  /api/v1/ops         list operations (name, scope, description, example params)
POST /api/v1/ops/:name   invoke one operation, JSON body = params
```

Responses use the standard `{ success, data, meta }` envelope.

## Auth and scopes

| Caller          | Auth               | read ops         | write ops         | admin ops         |
| --------------- | ------------------ | ---------------- | ----------------- | ----------------- |
| Agents (FAI)    | `tb_live_` API key | needs `ops:read` | needs `ops:write` | needs `ops:admin` |
| Dashboard users | JWT                | any role         | not CLIENT_VIEWER | PAIR_ADMIN only   |

Tenant is always resolved from auth. No operation accepts a tenant parameter.

## Operations

**Read:** `query` (keyword search: trigram on name fields + substring over data),
`get_entity` (entry + links + recent events), `list_entities`, `graph_query`
(typed-edge walk, depth 1-2), `timeline` (dated events), `daily_briefing`
(owner digest for one day), `health` (per-tenant stats).

**Write:** `ingest_conversation` (files a thread: upserts customer, stores
transcript idempotently by external_id, links customer to thread, keyword
signal detection for complaint / churn_risk / sales_intent in Arabic + English),
`upsert_entity` (typed create-or-merge with validation + versioning),
`capture` (freeform note to the inbox module, draft status), `link_entities`,
`log_event`, `set_status` (lifecycle status + audit event).

**Admin:** `schema` (get/set module type definitions), `reindex` (cache
invalidation; embedding backfill hangs off this when vector search lands).

All write and admin invocations produce an `audit_log` row (`action: ops:<name>`).

## Storage

Links and events live in two tenant-scoped tables added for this layer:
`entity_links` (typed edges between entries, unique per tenant/from/to/type) and
`entity_events` (dated timeline entries). RLS policies: `infra/migrations/0004_ops_rls.sql`
(apply after `prisma migrate deploy`, same as 0001-0003).

The ops layer auto-provisions three modules on first use: `conversations`,
`customers`, `inbox`.

## Known limits

- Retrieval is keyword-only (pg_trgm + ILIKE). Arabic morphology is not handled:
  embeddings are the planned fix, behind the same `query` operation.
- Signal detection is deterministic keyword matching, deliberately
  high-precision / low-recall. An LLM pass can replace it behind the same
  `ingest_conversation` contract.
