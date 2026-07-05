# Skill: answer-question

Customer asks anything factual: prices, classes, coaches, offers, schedules,
memberships, freeze rules, branches.

## Procedure

1. Extract the distinctive keyword(s) from the message. Drop filler; keep the
   noun that identifies the thing (`برن`, `عرض`, `membership`, coach name).
2. Call `query`:

```json
POST /ops/query
{ "question": "<keyword>", "limit": 5 }
```

If you know the content type, add `"type": "flare_memberships"` etc.: it cuts
noise substantially. 3. Read `results[].snippet` and `name`. If one result clearly answers, use it.
If several partially match, call `get_entity` on the best id for full data:

```json
POST /ops/get_entity
{ "id": "<result id>" }
```

4. Answer in the customer's language, short, with the concrete fact (price,
   time, name). One fact per sentence.

## On a miss

- Retry `query` once with a different keyword (Arabic ↔ English, or the bare
  root word). Retrieval is keyword-based; morphology matters.
- Still nothing → say you will check and connect a human. NEVER guess a price,
  a discount percentage, or a schedule. Then `capture` the gap so content gets
  fixed:

```json
POST /ops/capture
{ "text": "Customer asked: <question>. No answer found in the brain.", "hint_type": "content-gap" }
```

## Rules

- Quote prices and percentages EXACTLY as stored. Do not round, convert, or
  "roughly" anything.
- If the entry has `_en`/`_ar` localized fields, use the one matching the
  customer's language.
- If two entries contradict each other, prefer the one with the later
  `updated_at`, and `capture` the contradiction.
