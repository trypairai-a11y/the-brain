# The Brain · Agent Operations Layer: CTO Brief

**Status:** live in production · **Date:** July 5, 2026 · **API:** brain-flare.vercel.app · **Repo:** trypairai-a11y/the-brain

A contract-first operations layer, a knowledge graph, Kuwaiti-Arabic signal detection, and an agent skills pack: designed, built, verified, and shipped to production in one day. This brief has every detail: architecture, code paths, evidence, and what is deliberately not done yet.

## TL;DR

- The Brain now exposes **15 named operations** at `POST /api/v1/ops/:name`, defined once in a single registry file. FAI (and any future agent) uses this surface instead of ad-hoc endpoints.
- New capability, not just new plumbing: **typed links between entries, per-entity timelines, conversation ingestion with automatic complaint / churn / sales-intent detection on Kuwaiti Arabic text**, and a daily owner digest.
- An **agent skills pack** (`skills/` in the repo) teaches FAI when to call which operation. Wiring FAI is two steps: load one file into its system prompt, hand it an API key.
- Two latent production bugs were found and fixed on the way: Arabic POST bodies were 400-ing through the Vercel catchall, and a Redis outage could starve database transactions.
- Verified end-to-end on production with real Flare conversation data. Evidence in §8.
- One urgent action item: **rotate the seeded admin credentials** (§10).

## 1 · Why this exists

The Brain had one half of its loop: humans feed structured knowledge through the dashboard, and bots read a cached snapshot via `/knowledge-base`. What it lacked was the agent half: a way for FAI to _operate_ the brain: ask precise questions, file conversations back into it, accumulate customer memory, and surface what the owner needs to know. Without that, every Flare conversation evaporated after it ended.

We studied [gbrain](https://github.com/garrytan/gbrain) (Garry Tan's open-source personal knowledge brain) as the reference architecture, ran it locally against real Flare conversation exports, and made the call: **port its architecture, do not fork it**. gbrain is single-user to the bone; The Brain is multi-tenant with row-level security, which is the hard part we already had. What we ported is gbrain's three best ideas: a contract-first operations registry, typed entities with a link graph, and a skills layer that teaches agents to use the system.

## 2 · Architecture

```
FAI (WhatsApp / Instagram)                      Dashboard (React)
        │  tb_live_ API key                             │  JWT
        └──────────────┬────────────────────────────────┘
                       ▼
        POST /api/v1/ops/:name          apps/api/src/routes/ops.ts
          1 auth (dual: API key or JWT)
          2 scope check (read / write / admin)
          3 Zod param validation
          4 req.withTenant(tx) ── SET LOCAL app.tenant_id ── RLS fires
          5 handler from the registry   apps/api/src/ops/operations.ts
          6 audit_log row (write/admin ops)
                       ▼
        Postgres (Neon, Frankfurt)
          modules (types) · entries (typed data, versioned)
          entity_links (graph) · entity_events (timelines)   ← new
```

The core design decision is **contract-first**: `apps/api/src/ops/operations.ts` is the single source of truth. Each operation declares its name, scope, description, Zod parameter schema, an example, and its handler. The REST route is generated from that registry; nothing about an operation lives anywhere else. Consequences:

- `GET /api/v1/ops` is self-describing: it returns every operation with its scope and a working example. Agents discover the surface at runtime.
- Adding operation 16 is one entry in one file. Scope enforcement, validation, tenancy, and auditing come for free from the dispatcher.
- An MCP server can later be generated from the same registry, the way gbrain generates both its CLI and MCP surface from one contract. Zero rework.

**Deliberately reused, not rebuilt:**

- **Tenancy:** every handler runs inside `req.withTenant(tx)`, the existing transaction wrapper that sets `app.tenant_id` so Postgres RLS policies fire. Tenant identity comes from auth only; no operation accepts a tenant parameter.
- **Entry writes:** `upsert_entity` and ingestion reuse `services/entries.ts` (`createEntry` / `updateEntry`), inheriting field validation against module definitions, version history (last 50 snapshots), and cache invalidation.
- **Types are modules:** gbrain's "schema pack" concept maps onto the existing Module model (a module's `fieldDefinitions` JSONB is the type definition). No parallel type system was introduced.

## 3 · The 15 operations

Scope model: read < write < admin. Full parameter schemas are discoverable at `GET /api/v1/ops`.

| Operation             | Scope | What it does                                                                                                                                                                                                                                    |
| --------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`               | read  | Search the tenant's knowledge: trigram match on name fields plus substring match over all entry data, filterable by type and status. Returns ranked results with snippets. Keyword-only today; embeddings will land behind this same operation. |
| `get_entity`          | read  | One entry by id, or by type + external_id / name. Returns full data plus its links and 20 most recent events.                                                                                                                                   |
| `list_entities`       | read  | Entries of one type, filterable by status / updated-since. Powers sweeps like "open complaints" or "leads gone quiet".                                                                                                                          |
| `graph_query`         | read  | Walks typed links from an entry, depth 1–2, both directions, optional edge-type filter. Returns nodes + edges.                                                                                                                                  |
| `timeline`            | read  | Dated events for one entity or tenant-wide, filterable by event type and date range.                                                                                                                                                            |
| `daily_briefing`      | read  | Owner digest for one day: entries created/updated by type, detected signals with the customers behind them, recent events, open inbox count.                                                                                                    |
| `health`              | read  | Per-tenant stats: modules, entries by status, link and event counts, last write, retrieval mode.                                                                                                                                                |
| `ingest_conversation` | write | Files a finished thread. One call: upserts the customer, stores the transcript (idempotent on external_id), links customer ↔ conversation, logs events, runs signal detection. See §5.                                                          |
| `upsert_entity`       | write | Create-or-merge a typed entry by id or (type, external_id). Validates against the module's field definitions; writes a version; bumps the KB cache.                                                                                             |
| `capture`             | write | Freeform note into an auto-provisioned `inbox` module as a draft. The escape hatch when content cannot be typed yet.                                                                                                                            |
| `link_entities`       | write | Typed edge between two entries (participant, used_promo, attends, ...). Idempotent on (from, to, type).                                                                                                                                         |
| `log_event`           | write | Appends a dated event to an entity's timeline: joined, renewed, complained, churned.                                                                                                                                                            |
| `set_status`          | write | Lifecycle transition (draft / scheduled / active / expired / archived) with an audit event and reason.                                                                                                                                          |
| `schema`              | admin | Get or set the tenant's type definitions (modules + field definitions). Agent keys cannot call this.                                                                                                                                            |
| `reindex`             | admin | Cache invalidation + index state report. Embedding backfill will hang off this operation.                                                                                                                                                       |

**Dispatch flow per call:** auth (header starts with `Bearer tb_live_` → API-key plugin with SHA-256 lookup, revocation and expiry checks; otherwise JWT) → scope check (API keys need `ops:read` / `ops:write` / `ops:admin`; JWT viewers are read-only, admin ops require PAIR_ADMIN) → Zod validation (400 with the field named; nothing reaches a handler unvalidated) → handler inside the tenant transaction (RLS active, 15s budget) → `audit_log` row for every write/admin call (`action: ops:<name>`, large payloads truncated to counts).

## 4 · Data model changes

Two new tables. Everything else rides on existing models.

| Table           | Key columns                                                                                                | Purpose                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `entity_links`  | tenant_id, from_entry_id, to_entry_id, edge_type, created_by · unique on (tenant, from, to, type)          | The knowledge graph: typed edges between entries.                          |
| `entity_events` | tenant_id, entry_id, event_type, occurred_at, note, created_by · indexed (tenant, entry, occurred_at desc) | Per-entity timelines: joined, renewed, complaint_detected, status changes. |

- Prisma migration: `apps/api/prisma/migrations/20260705200000_ops_layer/`. Applied to Neon.
- RLS: `infra/migrations/0004_ops_rls.sql`. Both tables get `FORCE ROW LEVEL SECURITY` and the same tenant-isolation policy (with admin bypass) as every other tenant table. Applied to Neon.
- Both tables cascade-delete with their tenant and entries. Foreign keys enforced in Postgres.
- Three modules are auto-provisioned per tenant on first use: `conversations`, `customers`, `inbox`, each with proper field definitions so dashboard editing works on them like any other module.

## 5 · Conversation ingestion and signal detection

One `ingest_conversation` call performs, atomically, inside one transaction:

- **Customer upsert** keyed on phone number (E.164) as `external_id`, falling back to a name key.
- **Transcript storage** as a conversations entry: channel, start/end timestamps, escalation flag (any human agent present), full message log, agent-written summary. Idempotent on the platform thread id.
- **Graph edge** customer → conversation (`participant`).
- **Timeline events**: `conversation_ingested` on the thread, one `*_detected` event per signal on the customer.
- **Signal detection** over customer-authored messages only.

**Why detection is deliberately simple:** three signal categories (`complaint`, `churn_risk`, `sales_intent`), detected by deterministic keyword matching against curated Kuwaiti/Gulf Arabic and English lists (examples: مشكلة، ما اشتغل، استرجاع → complaint; الغاء، بطل الاشتراك → churn; سعر، خصم، كود → sales intent). Tuned high-precision / low-recall on purpose: a missed signal is recoverable, but a false complaint alert erodes the owner's trust in the morning briefing. It costs zero tokens, has zero latency, and cannot hallucinate. When we want recall, an LLM pass replaces the keyword function behind the exact same operation contract: callers never change.

Real production result, from an actual customer thread (the 33% discount code that applied as 10%):

```json
{
  "success": true,
  "data": {
    "conversation_id": "9b04d1df-...",
    "customer_id": "7f048fd3-...",
    "escalated": true,
    "signals": ["complaint", "sales_intent"]
  }
}
```

## 6 · The agent skills pack

gbrain's most transferable idea: the intelligence for using a knowledge system should live in versioned markdown the agent reads, not in prompt engineering scattered across the agent's codebase. `skills/` at the repo root ships a thin router plus six workflow skills:

| File                | Teaches                                                                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESOLVER.md`       | The routing table (trigger → skill), always-on rules (answer in the customer's dialect, never invent a price, 403 means stop), chaining rules. The one file loaded into FAI's system context. |
| `_api.md`           | Connection reference: base URL, auth, envelope, per-status error handling, external_id idempotency convention, keyword-retry guidance for Arabic queries.                                     |
| `answer-question`   | query → get_entity flow, exact-quote rules for prices, the no-guess fallback: on a miss, offer a human and capture the content gap.                                                           |
| `customer-context`  | Look up returning customers by phone before replying; recent complaints change tone; context shapes the reply, it is not the reply.                                                           |
| `file-conversation` | ingest_conversation after every thread, no exceptions, plus routing for each returned signal.                                                                                                 |
| `handle-complaint`  | Live-thread conduct (acknowledge once, no refund promises), event + capture recording, churn-retention protocol (record the stated reason; hand off on the second ask).                       |
| `record-facts`      | Durable-fact table: what maps to upsert_entity vs log_event vs link_entities. Facts only, dated, append-not-overwrite.                                                                        |
| `owner-briefing`    | daily_briefing → ten-second phone prose: lead with the number that matters, names not adjectives, skip zeros, every claim traceable to an id.                                                 |

**Wiring FAI is two steps:** load `skills/RESOLVER.md` into its system prompt, and set its `tb_live_` key (minted with scopes `read:kb + ops:read + ops:write`) as `BRAIN_API_KEY`. The skills already point at the production URL.

## 7 · Bugs found and fixed in the existing stack

Both were latent in production before this work; both are now fixed on main.

**7.1 Arabic POST bodies failed through the Vercel catchall.** All non-stubbed API routes on Vercel flow through `api/v1/catchall.ts`, which re-injects the request into Fastify. It forwarded the original `content-length` header while re-serializing the body that @vercel/node had already parsed. Multibyte content (any Arabic text) changes the byte count, so Fastify rejected with `FST_ERR_CTP_INVALID_CONTENT_LENGTH`. Impact: **every JSON POST containing Arabic through the catchall**, which would have included the chat endpoints, not just ops. Fix: drop `content-length` and `transfer-encoding` before injection and let Fastify compute the real length (commit `4634e2f`).

**7.2 A Redis outage could starve database transactions.** Cache invalidation runs inside the 5-second interactive database transaction. The Redis client was configured with blocking retries, so with Redis down each cache call burned ~2.5s of the transaction budget; two writes in one call guaranteed a timeout. Since all cache calls are already wrapped fail-soft, the correct posture is fail-fast: `commandTimeout: 500`, `maxRetriesPerRequest: 1`, no offline queue. Side effect: the API test suite dropped from 20s to 2.4s in Redis-less environments. Additionally, `withTenant()` now accepts a per-call transaction timeout; the ops dispatcher uses 15s because ingestion legitimately performs several writes.

## 8 · Verification

**Automated:**

- 8 new contract tests (`ops-contract.test.ts`): registry completeness (exactly the 15 contracted ops), scope assignments, every example validates against its own schema, invalid params rejected, Arabic + English signal detection.
- TypeScript clean across the API package.
- Full existing suite baselined before/after: 11 failures exist in the local environment (no Redis, RLS SQL not applied to the embedded dev database) _identically with and without these changes_. Nothing regressed.

**On production (brain-flare.vercel.app, real data):**

- `health`: 19 modules, 623 active entries, new tables live.
- `ingest_conversation` with a real Instagram thread in Kuwaiti Arabic: customer upserted, complaint + sales_intent detected, escalation flagged.
- `graph_query`: customer → conversation edge traversal.
- `daily_briefing`: full digest of the day's content.
- Scope enforcement: admin op with the agent key → 403 with the missing scope named.
- Idempotency: re-ingesting the same thread returns the same conversation and customer ids.

## 9 · Deployment topology

| Layer     | Detail                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Code      | `github.com/trypairai-a11y/the-brain`, git-connected to Vercel; every push to `main` auto-deploys.                                 |
| API + Web | Vercel project `the-brain`. Production alias: **brain-flare.vercel.app** (the older the-brain-six alias is dead).                  |
| Database  | Neon Postgres, Frankfurt (`eu-central-1`). Prisma migrations via `DATABASE_MIGRATE_URL`; RLS SQL applied out-of-band (0001–0004).  |
| Cache     | No Redis in production: the client stubs to no-ops when `REDIS_URL` is unset. Locally, embedded Postgres on :55433 via `pnpm dev`. |
| Commits   | `5741fab` ops layer · `7a07370` merge to main · `4634e2f` catchall fix · `b117898`/`5907f11` skills pack.                          |

## 10 · Security posture

> **Action required:** the production PAIR_ADMIN account still carries the seeded credentials from `infra/seed/` on a public URL. It can mint API keys for any tenant. Rotate it now; rotate the seeded editor account with it.

- API keys are stored as SHA-256 hashes; the raw key is shown exactly once at mint time. FAI's key was minted through the admin API with least-privilege scopes (no `ops:admin`).
- Tenant isolation is enforced in Postgres (RLS with `FORCE`), not in application code. The new tables carry the same policies as all tenant tables.
- Admin operations (`schema`, `reindex`) are unreachable with agent keys, and the skills explicitly instruct agents that a 403 is final.
- All write and admin invocations are audit-logged with the operation name and truncated parameters.
- Rate limiting: the existing 200 req/min per tenant+route limit applies to the ops surface unchanged.

## 11 · Known limits and the roadmap they imply

| Limit today                                                                                                           | Why acceptable now                                                                                         | Upgrade path                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Retrieval is keyword-only (pg_trgm + substring). Arabic morphology is not handled: اشتراك matches, الاشتراك can miss. | Skills teach keyword-retry tactics; FAI's questions are mostly entity-shaped (names, codes, class titles). | pgvector + embeddings behind the same `query` op, evaluated on Kuwaiti dialect specifically. The single highest-value next step, invisible to callers. |
| Signal detection is keyword-based, high-precision / low-recall.                                                       | Zero cost, zero latency, no hallucinated complaints in the briefing.                                       | LLM classification pass behind the same `ingest_conversation` contract.                                                                                |
| REST only; no MCP server yet.                                                                                         | FAI calls REST fine via the skills.                                                                        | Generate an MCP surface from the same operations registry; no handler changes.                                                                         |
| The graph starts empty for existing content (623 entries, no links yet).                                              | Links accrue automatically as conversations are ingested.                                                  | One-off backfill job linking existing content (coaches ↔ classes) if useful.                                                                           |
| Briefing day-window is UTC, not Asia/Kuwait.                                                                          | Off-by-three-hours at the edges of a day; content otherwise correct.                                       | Read the tenant's stored timezone in `daily_briefing`. Small, isolated change.                                                                         |

## 12 · File map

| Path                                                      | What lives there                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/api/src/ops/operations.ts`                          | The registry: all 15 operation definitions, helpers, signal keywords. Single source of truth. |
| `apps/api/src/routes/ops.ts`                              | Dispatch: dual auth, scope enforcement, validation, tenancy, audit.                           |
| `apps/api/src/__tests__/ops-contract.test.ts`             | Contract invariants + signal detection tests.                                                 |
| `apps/api/prisma/migrations/20260705200000_ops_layer/`    | DDL for entity_links + entity_events.                                                         |
| `infra/migrations/0004_ops_rls.sql`                       | RLS policies for the new tables.                                                              |
| `skills/`                                                 | RESOLVER.md + \_api.md + six workflow skills for FAI.                                         |
| `docs/ops-contract.md`                                    | In-repo reference for the surface.                                                            |
| `api/v1/catchall.ts`                                      | Vercel entry; carries the content-length fix.                                                 |
| `apps/api/src/lib/redis.ts` · `plugins/tenant-context.ts` | Fail-fast cache client · per-call transaction timeout.                                        |

---

_Built in Kuwait. Paired, not queued._
