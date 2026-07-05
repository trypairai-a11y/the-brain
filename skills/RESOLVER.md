# FAI Skill Resolver

This is the dispatcher for agents operating The Brain (FAI on WhatsApp + Instagram,
and any future agent). Skills are the implementation. **Read the skill file before
acting.** If two skills match, read both; they are designed to chain (answer a
question, then file the conversation when it ends).

All skills call the same surface: `POST /api/v1/ops/:name`. Connection details,
auth, and error handling live in `_api.md`. Read it once per session.

## Always-on rules (every message)

- Reply in the customer's language. Kuwaiti Arabic gets Kuwaiti Arabic, not MSA.
- Never invent facts about prices, schedules, memberships, or policies. If the
  brain has no answer, say so and offer a human. A wrong price costs more than
  a handoff.
- Never reveal ops responses raw. Translate data into a natural reply.
- The API key scopes what you can do. If an op returns 403, that action is not
  yours to take; do not retry.

## Routing table

| When                                                                               | Skill                        |
| ---------------------------------------------------------------------------------- | ---------------------------- |
| Customer asks about classes, prices, coaches, offers, hours, anything factual      | `answer-question/SKILL.md`   |
| A returning customer messages (phone number seen before)                           | `customer-context/SKILL.md`  |
| Conversation ends, goes idle, or is handed to a human                              | `file-conversation/SKILL.md` |
| Customer is unhappy, reports a problem, or ingest returned a `complaint` signal    | `handle-complaint/SKILL.md`  |
| Customer states a durable fact (renewed, changed goal, new phone, prefers a coach) | `record-facts/SKILL.md`      |
| Owner or manager asks "what happened today", or the morning digest job fires       | `owner-briefing/SKILL.md`    |

## Chaining rules

- `file-conversation` runs after EVERY customer thread, no exceptions. It is how
  the brain learns.
- If `ingest_conversation` returns signals, route each one: `complaint` →
  handle-complaint; `churn_risk` → handle-complaint (retention section);
  `sales_intent` → nothing extra now, the signal is logged for the briefing.
- `record-facts` piggybacks on other skills; it never replaces filing the thread.

## What agents must not do

- No `schema` or `reindex` calls. Admin ops belong to humans in the dashboard.
- No cross-tenant anything. The key pins the tenant; there is no override.
- No bulk writes in a reply loop. If you find yourself calling upsert_entity
  more than 3 times for one message, stop and capture a note instead.
