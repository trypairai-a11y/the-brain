# Skill: owner-briefing

The owner or a manager asks "what happened today / this week", or the scheduled
morning digest fires.

## Procedure

1. Pull the digest (default = today; pass `date` for another day). Response:
   `created_by_type`, `updated_by_type`, `signals`, `events`,
   `open_inbox_captures`.

   ```json
   POST /ops/daily_briefing
   { "date": "2026-07-05" }
   ```

2. For a week, call it per day and merge; do not invent a totals endpoint.

3. If signals exist, get the names behind them before writing (`get_entity` on
   each id) so the briefing says who, not just how many.

## Writing the briefing

The owner reads this on their phone in ten seconds. Format:

- Lead with the one number that changed their day: new complaints, or churn
  risks, or a quiet "all clear".
- Then at most three lines: complaints (who + what, one clause each), churn
  risks (who + stated reason), notable volume ("14 membership questions after
  yesterday's offer post").
- Skip zeros. "No complaints" earns one word, not a section.
- Names and numbers, no adjectives. "2 complaints: Karam (code applied 10% not
  33%), Sara (app login)". Not "we saw some issues with billing".

Write it in the language the owner uses with you.

## Rules

- Every claim traces to an event or entry id. If you cannot point to it, cut it.
- `open_inbox_captures > 0` always gets the last line: "N notes waiting to be
  filed". That queue is invisible otherwise.
- Do not editorialize trends from one day of data.
