# Skill: customer-context

A returning customer messages. Pull who they are before replying, so the second
conversation does not start from zero.

## Procedure

1. Look up the customer by phone (the external_id convention). 404 → new
   customer; skip this skill, and `file-conversation` will create them when the
   thread ends.

   ```json
   POST /ops/get_entity
   { "type": "customers", "external_id": "+96599365531" }
   ```

2. The response carries `data` (name, phone, notes), `links` (their
   conversations), and `events` (their timeline). Scan events first: a
   `complaint_detected` or `churn_risk_detected` in the last 30 days changes
   your tone; a recent `renewed` is worth acknowledging.

3. For depth, walk the graph or timeline:

   ```json
   POST /ops/graph_query
   { "id": "<customer id>", "depth": 1 }
   ```

   ```json
   POST /ops/timeline
   { "id": "<customer id>", "limit": 10 }
   ```

## How to use context

- Greet by name. Reference the open thread only if it is unresolved ("بخصوص
  موضوع الكود، انحل معاك؟").
- An unresolved complaint outranks whatever they are asking now: acknowledge it
  first, one sentence.
- Do NOT recite their history back at them. Context shapes your reply; it is
  not the reply.

## Rules

- Phone in E.164 with `+`. If you only have a name, `{ "type": "customers",
"name": "<name>" }` works but is weaker; prefer phone.
- Never mention other customers' data, ever, even as an example.
