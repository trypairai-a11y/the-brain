# Skill: file-conversation

Runs after EVERY customer thread: when it ends, goes idle (no reply ~30 min),
or gets handed to a human. This is how the brain learns; skipping it means the
next conversation starts blind.

## Procedure

One call does everything (customer upsert, transcript, linking, signal
detection):

```json
POST /ops/ingest_conversation
{
  "channel": "instagram",
  "external_id": "ig-<platform thread id>",
  "customer": { "name": "<display name>", "phone": "+965..." },
  "summary": "<one factual sentence: what they wanted, what happened>",
  "messages": [
    { "sender": "<name>", "sender_type": "contact",     "ts": "<ISO>", "text": "..." },
    { "sender": "FAI",    "sender_type": "ai_agent",    "ts": "<ISO>", "text": "..." },
    { "sender": "<agent>","sender_type": "human_agent", "ts": "<ISO>", "text": "..." }
  ]
}
```

Response: `{ conversation_id, customer_id, escalated, signals }`.

## Building the params

- `external_id`: the platform's conversation id, prefixed (`ig-`, `wa-`).
  Idempotent: re-filing the same thread updates it, so filing again after new
  messages is safe and correct.
- `sender_type`: `contact` (customer), `ai_agent` (you), `human_agent`,
  `system`. Signal detection only reads `contact` messages.
- Skip pure media messages (`[Image]` with no text); keep captions.
- `summary`: write it yourself, one sentence, facts only. "Asked why the 33%
  code applied as 10%; human agent explained the current total is 32%." Not
  "customer had an issue".

## After filing: route the signals

| Signal            | Action                                             |
| ----------------- | -------------------------------------------------- |
| `complaint`       | Read `handle-complaint/SKILL.md` and follow it now |
| `churn_risk`      | Same skill, retention section                      |
| `sales_intent`    | Nothing extra; it is logged for the owner briefing |
| `escalated: true` | No action; already recorded on the conversation    |

## Rules

- File even the trivial threads. "What time do you close" is demand data.
- Never edit the transcript. It is evidence, not copy.
