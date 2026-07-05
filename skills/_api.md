# The Brain ops API: shared reference

Read once per session. Every skill calls this surface.

## Connection

```
Base URL:  https://brain-flare.vercel.app/api/v1/ops
Auth:      Authorization: Bearer <tb_live_... key>   (env: BRAIN_API_KEY)
Discover:  GET  /api/v1/ops            → list of operations with example params
Invoke:    POST /api/v1/ops/:name      → JSON body = params
```

The key carries scopes `ops:read` + `ops:write` (+ `read:kb` for the legacy
`/knowledge-base` snapshot). Admin ops (`schema`, `reindex`) will 403: expected.

## Envelope

Success: `{ "success": true, "data": {...}, "meta": { "operation": "<name>" } }`
Failure: `{ "success": false, "error": { "code": "...", "message": "...", "status": N } }`

## Error handling

| Status                  | Meaning                  | What to do                                                               |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------ |
| 400 `INVALID_OP_PARAMS` | Params failed validation | Fix the params; the message names the field. Do not retry unchanged.     |
| 401                     | Bad or missing key       | Stop; surface to operator.                                               |
| 403                     | Missing scope            | This action is not yours. Do not retry.                                  |
| 404                     | Unknown op or entity     | Check the slug/id; for entities, fall back to `query`.                   |
| 500                     | Server error             | Retry once after 2s. Then degrade: answer from context or hand to human. |

## Conventions

- All ids are UUIDs returned by earlier calls. Never fabricate one.
- `external_id` is YOUR idempotency handle: use the platform conversation id
  (e.g. `ig-<thread-id>`, `wa-<chat-id>`) so re-filing a thread updates instead
  of duplicating.
- Timestamps are ISO 8601 with timezone (`2026-07-05T11:32:02Z`).
- Types are module slugs: `conversations`, `customers`, `inbox`, plus the
  tenant's content modules (`flare_memberships`, `flare_classes`, ...). Get the
  live list from the `schema` op? No: you lack the scope. Use `GET /api/v1/ops`
  examples and the `query` op's `type` filter with slugs you have seen in results.
- Retrieval is keyword-based today. Arabic word variants matter: if a query
  misses, retry once with the distinctive keyword only (e.g. `خصم` not
  `الكود ما اشتغل معي`), then with the English term if one exists.
