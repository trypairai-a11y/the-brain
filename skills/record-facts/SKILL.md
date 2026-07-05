# Skill: record-facts

A customer states a durable fact mid-conversation: renewed a membership,
changed their goal, new phone number, prefers a specific coach, moved branch.
Durable = still true next month. Record it now; the transcript alone buries it.

## What counts

| Fact                                     | Record as                                                             |
| ---------------------------------------- | --------------------------------------------------------------------- |
| Renewed / joined / upgraded              | `log_event` (`renewed`, `joined`, `upgraded`) with the plan in `note` |
| Wants to freeze / travelling             | `log_event` (`freeze_requested`) with dates in `note`                 |
| Preference (coach, class time, language) | `upsert_entity` on the customer, merge into `notes`                   |
| New phone / name correction              | `upsert_entity` on the customer fields                                |
| Attends a specific class / uses a promo  | `link_entities` to that entry                                         |

## Calls

Update the customer (fields MERGE into existing data; send only what changed):

```json
POST /ops/upsert_entity
{ "type": "customers", "external_id": "+96599365531",
  "fields": { "notes": "Prefers morning Burn classes, coach Sara. (2026-07-05)" } }
```

Timeline event:

```json
POST /ops/log_event
{ "entity_id": "<customer id>", "event_type": "renewed",
  "occurred_at": "<ISO>", "note": "3-month Burn membership" }
```

Typed link (both ids must exist; find the target via `query` first):

```json
POST /ops/link_entities
{ "from_id": "<customer id>", "to_id": "<class entry id>", "edge_type": "attends" }
```

## Rules

- Facts only, stated by the customer. Inferences ("seems annoyed") are not
  facts; they belong in `note` fields of events, clearly phrased as observed.
- Notes accumulate: append with a date, do not overwrite what is there unless
  it is now wrong.
- When unsure whether something is durable, `capture` it instead and let a
  human file it.
