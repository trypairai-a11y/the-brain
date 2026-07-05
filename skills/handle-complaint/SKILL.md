# Skill: handle-complaint

A customer is unhappy, reports something broken, or `ingest_conversation`
returned a `complaint` or `churn_risk` signal.

## In the conversation (if it is still live)

1. Acknowledge in their dialect, once, without corporate filler. Own the next
   step ("بشيك عليها الحين وأرد لك").
2. Do not promise refunds, extensions, or exceptions. Those are human calls:
   escalate to a human agent and say you did.

## Recording it (always, even after the thread closed)

1. Log the event on the customer so it shows in their timeline and the owner
   briefing (skip if the signal came from `ingest_conversation`: it already
   logged one):

```json
POST /ops/log_event
{ "entity_id": "<customer id>", "event_type": "complaint_detected",
  "occurred_at": "<ISO>", "note": "<one sentence: what is wrong>" }
```

2. Capture the substance so the team sees it without reading transcripts:

```json
POST /ops/capture
{ "text": "<customer name>, <phone>: <what is wrong, verbatim detail>. Thread ig-<id>.",
  "hint_type": "complaints" }
```

3. If the complaint reveals wrong content in the brain (a price, a rule, an
   offer that customers keep misreading), capture that separately with
   `hint_type: "content-gap"`.

## Retention section (churn_risk)

Customer wants to cancel or stop:

- Never argue, never re-pitch in the same breath. Acknowledge, ask one open
  question ("شنو اللي خلاك تفكر توقف؟"), record the answer.
- `log_event` with `event_type: "churn_risk_detected"` and the stated reason in
  `note`. The reason is the valuable part; "wants to cancel" alone is noise.
- Hand to a human if they ask twice. A second ask is a decision, not a mood.

## Rules

- One event per complaint, not one per angry message.
- The `note` field is read by the owner in the morning. Write it for them:
  concrete, no drama.
