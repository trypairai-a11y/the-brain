# The Brain: internal API reference

The integration contract between **The Brain** (Pair's knowledge hub) and the
**AI agent** (FAI: Flare Fitness's WhatsApp + Instagram concierge), plus the
dashboard and admin surfaces the Pair team uses to run it.

This is the document you hand a Pair engineer or an agent builder who needs to
wire something to The Brain. It is generated from the live code, not aspiration:
every operation below is dispatched from a single registry
(`apps/api/src/ops/operations.ts`) and served at the base URL below today.

- **Base URL (prod):** `https://brain-flare.vercel.app/api/v1`
- **Dashboard:** `https://brain-flare.vercel.app`
- **Health:** `GET /api/v1/health` (no auth) and the `health` op (auth)
- **Status envelope:** every response is `{ success, data, meta }` or `{ success:false, error }`

---

## 1. The one thing to understand first

The Brain has **two front doors**, and which one you use is decided entirely by
your credential:

| Caller                             | Credential                 | Front door                               | What it is for                                     |
| ---------------------------------- | -------------------------- | ---------------------------------------- | -------------------------------------------------- |
| **The AI agent (FAI)** and any bot | `tb_live_` **API key**     | `/api/v1/ops` + `/api/v1/knowledge-base` | Read the knowledge, file conversations, log events |
| **A human on the team**            | **JWT** from `/auth/login` | The dashboard + `/api/v1/*` routes       | Edit content, manage modules, read analytics       |

The same `/api/v1/ops` endpoint accepts **both** credentials and enforces the
same scopes against each. An agent key and a dashboard login are just two ways to
prove who you are; the operation surface is identical. This is deliberate: the
contract lives in one place, and a new operation reaches the agent and the
dashboard at the same time.

**To connect the AI agent, you need exactly two things:**

1. A `tb_live_` API key with scopes `read:kb`, `ops:read`, `ops:write` (§6).
2. The agent skills in `skills/` loaded into the agent's context (§8).

Everything else in this document is detail.

---

## 2. Authentication

### 2.1 Agent / bot: API key

```
Authorization: Bearer tb_live_<key>
```

The key is issued once (§6), stored only as a SHA-256 hash, and carries a fixed
set of **scopes**. The tenant is resolved from the key: an agent never sends a
tenant id, and cannot reach another tenant's data. Revoked or expired keys return
`401`.

### 2.2 Human: JWT

```
POST /api/v1/auth/login
Content-Type: application/json

{ "tenantSlug": "flare-fitness", "email": "you@pair.ai", "password": "..." }
```

Returns:

```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1Ni...",
    "user": { "id": "...", "email": "...", "name": "...", "role": "CLIENT_EDITOR" },
    "tenant": { "id": "...", "slug": "flare-fitness", "name": "Flare Fitness" }
  }
}
```

Send the token as `Authorization: Bearer <token>` on subsequent calls. Login is
rate-limited to **5 attempts / 5 minutes** per client. Tokens are signed JWTs
carrying `sub` (user id), `tenantId`, and `role`.

### 2.3 Password management

```
POST /api/v1/me/password                     (any logged-in user)
     { "currentPassword": "...", "newPassword": "..." }   newPassword min 8

POST /api/v1/admin/users/:id/reset-password  (PAIR_ADMIN)
     { "newPassword": "..." }   omit to have one generated and returned once
```

Self-service change requires the current password, so a stolen but still-valid
token cannot lock the owner out. The admin reset is the operator path for a
lockout (there is no email-based reset flow yet). New team members should change
their generated password on first login via `me/password`.

---

## 3. Roles and scopes

Two orthogonal permission systems, one per credential type.

**Human roles** (`packages/shared/src/roles.ts`):

| Role            | Can                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------- |
| `PAIR_ADMIN`    | Everything, including admin ops and the `/admin` provisioning routes. Pair staff only.       |
| `CLIENT_EDITOR` | Read + write content and run read/write ops. The default for the Flare/Macro operating team. |
| `CLIENT_VIEWER` | Read-only. Dashboards and reports, no edits.                                                 |
| `API_CONSUMER`  | Reserved for programmatic human tokens; not used by the agent.                               |

**API-key scopes** (`ApiScope`):

| Scope             | Grants                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `read:kb`         | The `/knowledge-base` snapshot.                                                                                       |
| `ops:read`        | All read operations (`query`, `get_entity`, `list_entities`, `graph_query`, `timeline`, `daily_briefing`, `health`).  |
| `ops:write`       | All write operations (`ingest_conversation`, `upsert_entity`, `capture`, `link_entities`, `log_event`, `set_status`). |
| `ops:admin`       | Admin operations (`schema`, `reindex`). Do **not** grant to the agent.                                                |
| `write:analytics` | Analytics event ingestion (reserved).                                                                                 |

**The FAI production key carries `read:kb` + `ops:read` + `ops:write`.** It will
correctly get a `403` on `schema` and `reindex`; that is the design, not a bug.

---

## 4. The response envelope

Success:

```json
{ "success": true, "data": { ... }, "meta": { "operation": "query" } }
```

Failure:

```json
{
  "success": false,
  "error": { "code": "INVALID_OP_PARAMS", "message": "question: Required", "status": 400 }
}
```

### Error handling (build this into the agent)

| Status | Code (typical)      | Meaning                                     | What the caller should do                                                     |
| ------ | ------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| 400    | `INVALID_OP_PARAMS` | Params failed Zod validation                | Read `message` (it names the field), fix, do **not** retry unchanged          |
| 401    | `UNAUTHORIZED`      | Bad / missing / revoked key or token        | Stop. Surface to an operator. Never loop                                      |
| 403    | `FORBIDDEN`         | Credential lacks the scope/role for this op | Not yours to call. Do not retry                                               |
| 404    | `NOT_FOUND`         | Unknown operation, or entity not found      | Check the slug/id; for entities fall back to `query`                          |
| 429    | rate limited        | 200 req/min per tenant per route exceeded   | Back off, retry after the window                                              |
| 500    | `INTERNAL`          | Server error                                | Retry **once** after 2s, then degrade: answer from context or hand to a human |

Rate limit: **200 requests / minute**, keyed per tenant per route. Login: 5/5min.

---

## 5. The operations layer (the agent's surface)

```
GET  /api/v1/ops           List every operation: name, scope, description, example params
POST /api/v1/ops/:name     Invoke one operation. JSON body = params
```

`GET /api/v1/ops` is the live, self-describing contract: it returns the 15
operations with an example param object for each. An agent should call it once
per session to discover the surface rather than hard-coding it.

All write and admin invocations write an `audit_log` row (`action: ops:<name>`).
Ids are UUIDs returned by prior calls; never fabricate one. Timestamps are ISO
8601 with timezone. `external_id` is the **caller's idempotency handle**: pass the
platform conversation id (`ig-<thread>`, `wa-<chat>`) so re-filing updates instead
of duplicating.

### 5.1 Read operations (`ops:read`)

| Op               | Purpose                                                                                                                                    | Key params                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `query`          | Search the tenant's knowledge. Trigram on name fields + substring over all data. Keyword-only today (embeddings land behind this same op). | `question` (req), `type?`, `status?`, `limit=10`      |
| `get_entity`     | One typed entry by `id`, or by `type` + `external_id`/`name`. Includes links and recent events.                                            | `id` **or** `type`+`name`/`external_id`               |
| `list_entities`  | List entries of one type, filter by status or `updated_since`. For sweeps ("open complaints").                                             | `type` (req), `status?`, `updated_since?`, `limit=25` |
| `graph_query`    | Walk typed links from an entry, depth 1-2, both directions. "Everything connected to this customer."                                       | `id` (req), `depth=1`, `edge_type?`                   |
| `timeline`       | Dated events for one entry or tenant-wide (joined, renewed, complained, churned).                                                          | `id?`, `event_type?`, `from?`, `to?`, `limit=50`      |
| `daily_briefing` | Owner digest for one day: entries created/updated by type, events, detected signals, open inbox.                                           | `date?` (YYYY-MM-DD, default today UTC)               |
| `health`         | Per-tenant stats: entries by status, module count, links, events, last write.                                                              | none                                                  |

### 5.2 Write operations (`ops:write`)

| Op                    | Purpose                                                                                                                                                                                                                  | Key params                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `ingest_conversation` | File a finished thread: upserts the customer, stores the transcript idempotently on `external_id`, links customer↔thread, logs events, runs keyword **signal detection** (complaint / churn_risk / sales_intent, AR+EN). | `channel`, `external_id` (req), `customer{name,phone?}` (req), `messages[]` (req), `summary?` |
| `upsert_entity`       | Create or update a typed entry. Matches by `id` or (`type`,`external_id`); on update fields **merge**. Validates against the module's field defs, versions, bumps cache.                                                 | `type` (req), `fields` (req), `id?`, `external_id?`, `status?`                                |
| `capture`             | Freeform note into the inbox (draft) when it can't be typed yet. Filed into a typed entry later.                                                                                                                         | `text` (req), `hint_type?`                                                                    |
| `link_entities`       | Idempotent typed edge between two entries. Edge types are free-form (`participant`, `used_promo`, `attends`).                                                                                                            | `from_id`, `to_id`, `edge_type` (all req)                                                     |
| `log_event`           | Append a dated event to an entry's timeline.                                                                                                                                                                             | `entity_id`, `event_type` (req), `occurred_at?`, `note?`                                      |
| `set_status`          | Lifecycle transition (draft/scheduled/active/expired/archived) + audit event. Workflow states (open/resolved) belong in `upsert_entity` fields, not here.                                                                | `id`, `status` (req), `reason?`                                                               |

### 5.3 Admin operations (`ops:admin`, PAIR_ADMIN only)

| Op        | Purpose                                                                                                         | Key params                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `schema`  | Get or set the tenant's module (type) definitions. `set` upserts one module's label/icon/field definitions.     | `action: "get"` \| `"set"` (+ `type`,`label`,`field_definitions`) |
| `reindex` | Invalidate the KB cache and report index state. Embedding backfill will hang off this when vector search lands. | none                                                              |

### 5.4 Worked examples

**Discover the surface**

```bash
curl -s https://brain-flare.vercel.app/api/v1/ops \
  -H "Authorization: Bearer tb_live_<key>"
```

**Answer a customer question (read)**

```bash
curl -s -X POST https://brain-flare.vercel.app/api/v1/ops/query \
  -H "Authorization: Bearer tb_live_<key>" \
  -H "Content-Type: application/json" \
  -d '{ "question": "كود الخصم", "type": "flare_memberships", "limit": 5 }'
```

**File a finished WhatsApp thread (write, idempotent)**

```bash
curl -s -X POST https://brain-flare.vercel.app/api/v1/ops/ingest_conversation \
  -H "Authorization: Bearer tb_live_<key>" \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "whatsapp",
    "external_id": "wa-9665xxxx",
    "customer": { "name": "Karam Zoubi", "phone": "+96599365531" },
    "messages": [
      { "sender": "Karam Zoubi", "sender_type": "contact",
        "ts": "2026-07-05T11:32:02Z", "text": "الكود ما اشتغل" }
    ],
    "summary": "Promo code not applying; asked customer to retry at checkout"
  }'
```

Response: `{ "conversation_id": "...", "customer_id": "...", "escalated": false, "signals": ["complaint"] }`.

> **Arabic retrieval caveat.** Search is keyword-only (pg_trgm + ILIKE); Arabic
> morphology is not handled (`اشتراك` hits, `الاشتراك` misses). If a `query`
> misses, retry once with the distinctive keyword only, then with the English
> term. Embeddings are the planned fix, behind the same `query` op. See §9.

---

## 6. Provisioning: keys and accounts (Pair internal)

These routes require a **PAIR_ADMIN** JWT. This is how Pair mints the agent's key
and creates dashboard accounts for the Flare/Macro team.

```
POST /api/v1/admin/api-keys   { tenantId, label, scopes[] }   -> { apiKey } (shown once)
POST /api/v1/admin/users      { tenantId, email, password, name, role }
POST /api/v1/admin/tenants    { name, slug, ... }
POST /api/v1/admin/modules    { tenantId, ...ModuleSchema }
```

**Mint the FAI key:**

```bash
TOKEN=$(curl -s -X POST https://brain-flare.vercel.app/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"tenantSlug":"flare-fitness","email":"admin@pairai.com","password":"<admin-pw>"}' \
  | jq -r .data.token)

curl -s -X POST https://brain-flare.vercel.app/api/v1/admin/api-keys \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "tenantId":"4d8eef42-2260-473d-9dda-1ac6a7225d70",
        "label":"FAI production key",
        "scopes":["read:kb","ops:read","ops:write"] }'
```

The raw key is returned **once** (`meta.warning: "shown once"`). Store it in the
agent's secret store as `BRAIN_API_KEY`; it cannot be retrieved again, only
re-minted. `flare-fitness` tenantId is `4d8eef42-2260-473d-9dda-1ac6a7225d70`.

**Create a team account:** see §7 and `scripts/provision-team.mjs`.

---

## 7. Wiring the AI agent, end to end

1. **Mint the key** (§6) with `read:kb`, `ops:read`, `ops:write`. Store as `BRAIN_API_KEY`.
2. **Load the skills.** Put `skills/RESOLVER.md` into the agent's system context.
   It is a routing table; it reads the six workflow skills on demand and shares
   `skills/_api.md` (the same connection facts as this doc, agent-sized).
3. **On each turn**, the agent:
   - retrieves with `query` / `get_entity` / `list_entities` before answering;
   - after a thread closes, files it with `ingest_conversation` (idempotent on the
     platform thread id) so signals and timeline populate;
   - captures anything it cannot yet type with `capture`.
4. **The owner digest** (`daily_briefing`) drives the daily brief to the Flare/Macro team.

The agent never needs a human login and never sees admin ops. If it asks for the
`schema`, that is a prompt bug: types are discoverable from `query`/`list_entities`
results and the `GET /api/v1/ops` examples.

---

## 8. The `/knowledge-base` snapshot (legacy, still live)

```
GET /api/v1/knowledge-base       Authorization: Bearer tb_live_<key>   (scope read:kb)
GET /api/v1/search?q=...          keyword search over the same
```

Returns every **active** entry grouped by module slug, Redis-cached with a
versioned key and a 24h emergency fallback keyspace. This predates the ops layer;
prefer `query`/`list_entities` for new agent work. The snapshot remains for bulk
"load the whole brain into context" use.

---

## 9. Known limits (say these out loud, do not paper over them)

- **Retrieval is keyword-only** (pg_trgm + ILIKE). Arabic morphology is not
  handled. Embeddings are the planned fix, behind the same `query` op; `reindex`
  is where the backfill will hang.
- **Signal detection is deterministic keyword matching** (`ingest_conversation`),
  deliberately high-precision / low-recall. A missed signal is recoverable; a
  false complaint alert erodes trust in the briefing. An LLM pass can replace it
  behind the same contract.
- **Conversational feed** (`/chat/*`) needs `ANTHROPIC_API_KEY`; it is parked
  (placeholder secret in prod) until that half of the loop is un-parked.

---

## 10. Reference

- Operations registry (source of truth): `apps/api/src/ops/operations.ts`
- REST dispatch: `apps/api/src/routes/ops.ts`
- Ops contract narrative: `docs/ops-contract.md`
- Agent skills: `skills/RESOLVER.md`, `skills/_api.md`, `skills/<workflow>/`
- Provisioning script: `scripts/provision-team.mjs`
- Roles + scopes: `packages/shared/src/roles.ts`

_Built in Kuwait. Paired, not queued._
