---
description: Scan UNH's pages for recurring events the calendars miss, judge the leads, and keep src/social/curated.json fresh
---

Refresh the hand-kept series in `src/social/curated.json` (schema and meaning in `src/social/curated.mts`, design in `docs/social.md`). Work in a branch off `main`; don't merge or deploy.

1. **Scan.** Install the inputs if they aren't (`node scripts/inputs.mts --dev`, for the gazetteer, the courses and the events), then run `node scripts/leads.mts`. It writes `leads.md`: pages with leads, each lead with its score, what it was read as (days, times, place), its hash, the heading it's under, its passage, and where its days read as one, the rule proposed for them. Its first paragraph counts what was left out and why.

2. **Judge `leads.md` from the top**, opening the page when the passage alone doesn't settle it. For each lead, either:
   - **Accept** it into `curated.json` when it's something anyone may go to, in Durham, again and again or on dates the page names, with days and a start and an end the page states. Fill each field from the page: `title` as the page names it; `where` as written, which must name a place the gazetteer knows (check it with `placeMatcher` from `src/social/aliases.mts` if unsure); `sessions`, one `{ rule, start, end }` for each time of day it's at, `start` and `end` as `HH:MM`, so a group meeting Tuesdays at one time and Thursdays at another is one series of two sessions; `url`; `passage`, the words the times came from, copied verbatim; `checked`, today.

     A session's `rule` says its days (`src/shared/recur.mts`): the dates the page names, where it names them, however it words how often; else its wording.

     | The page says | `rule` |
     |---|---|
     | these dates, or "every other Wednesday" with its dates | `{ "on": ["2026-09-16", "2026-09-30"] }` |
     | every Friday | `{ "weekly": ["Fri"] }` |
     | every other Wednesday, biweekly, naming no dates | `{ "of": { "weekly": ["Wed"] }, "every": 2, "from": "2026-09-16" }`, `from` a day it's on |
     | first Tuesday of the month, last Friday | `{ "nth": 1, "weekday": "Tue" }`, `{ "nth": -1, "weekday": "Fri" }` |
     | first and third Thursdays | `{ "any": [{ "nth": 1, "weekday": "Thu" }, { "nth": 3, "weekday": "Thu" }] }` |
     | …but not over Thanksgiving | `{ "of": …, "except": { "on": ["2026-11-25"] } }` |

     Wrap every rule that isn't dates alone in `{ "of": …, "between": [from, until] }`: the dates the page gives, else the term's (its dates are in `src/courses/courses.json` under `calendar.terms`), never past the term's end, so a series nobody checks again ends on its own; the schema refuses a session with no last day. Start from the rule `leads.md` proposes and check it against the page (`occurrences` in `src/shared/recur.mts` lists a rule's days).
   - **Reject** it, with a short reason, as the rule it suggests: "a class", "office hours", "past", "online", "not in Durham", "times not stated", "a one-time event 25Live lists".

   A one-time event is rarely worth a record: the installed `src/map/events.json` may be days old, so search UNH's calendar (25Live) for it before accepting, and reject it as "a one-time event 25Live lists" if it's there.

   Record every verdict in `leads-seen.json` by the lead's hash: `{ "verdict": "accepted" | "rejected", "reason": "…", "url": "…", "judged": "YYYY-MM-DD" }` (`Seen` in `src/social/leads.mts`), so it isn't asked again until its words change.

3. **Check the series already kept.** For each record in `curated.json`, open its `url`. If its passage still says the same, set `checked` to today. If the times changed, update the record and its passage from the page. If the page no longer says it, or the term it was for is over, remove it.

4. **Never guess.** Don't invent a time, a place, an end, a weekday or a date the page doesn't state. "Every other Wednesday" with no day to count from, which the scanner proposes no rule for, "TBD", "times vary", or a page that contradicts itself is a rejection ("times not stated"), unless the page or the club's own calendar names one of its days. Leave out anything ambiguous. Never put a person's email address or phone number in a record or a verdict.

5. **Turn recurring rejections into rules.** When several leads were rejected for the same reason, make it a rule in `src/social/leads.mts`, cheapest first: a page pattern in `NOT_PAGES`, a wording in `NOT_WORDING`, or a seed's scope in `scripts/leads.mts`, with a case in `tests/social/leads.test.mts`. Run the scanner again to see the rule leave them out.

6. **Check and report.** Run `npm run typecheck` and `npx vitest run tests/social`. Then report: how many leads `leads.md` had, how many were accepted and rejected (the noise rate), the series added, updated and removed, and the rules added. Commit `curated.json`, `leads-seen.json` and any rules; `leads.md` is not committed.
