---
description: Scan UNH's pages for recurring events the calendars miss, judge the leads, and keep src/social/curated.json fresh
---

Refresh the hand-kept series in `src/social/curated.json` (schema and meaning in `src/social/curated.mts`, design in `docs/social.md`). Work in a branch off `main`; don't merge or deploy.

1. **Scan.** Install the inputs if they aren't (`node scripts/inputs.mts --dev`, for the gazetteer, the courses and the events), then run `node scripts/leads.mts`. It writes `leads.md`: pages with leads, each lead with its score, what it was read as (days, times, place), its hash, the heading it's under, and its passage. Its first line counts what was left out and why.

2. **Judge `leads.md` from the top**, opening the page when the passage alone doesn't settle it. For each lead, either:
   - **Accept** it into `curated.json` when it's something anyone may go to, in Durham, again and again or on dates the page names, with a weekday or dates and a start and an end the page states. Fill each field from the page: `title` as the page names it; `where` as written, which must name a place the gazetteer knows (check it with `placeMatcher` from `src/social/aliases.mts` if unsure); `days` (`Mon`…`Sun`) or `dates`, never both; `start` and `end` as `HH:MM`; `from` and `until` as the dates the page gives, else the term's (its dates are in `src/courses/courses.json` under `calendar.terms`), never past the term's end; `url`; `passage`, the words the times came from, copied verbatim; `checked`, today.
   - **Reject** it, with a short reason, as the rule it suggests: "a class", "office hours", "past", "online", "not in Durham", "times not stated", "a one-time event 25Live lists".

   A one-time event is rarely worth a record: the installed `src/map/events.json` may be days old, so search UNH's calendar (25Live) for it before accepting, and reject it as "a one-time event 25Live lists" if it's there.

   Record every verdict in `leads-seen.json` by the lead's hash: `{ "verdict": "accepted" | "rejected", "reason": "…", "url": "…", "judged": "YYYY-MM-DD" }` (`Seen` in `src/social/leads.mts`), so it isn't asked again until its words change.

3. **Check the series already kept.** For each record in `curated.json`, open its `url`. If its passage still says the same, set `checked` to today. If the times changed, update the record and its passage from the page. If the page no longer says it, or the term it was for is over, remove it.

4. **Never guess.** Don't invent a time, a place, an end, a weekday or a date the page doesn't state. "Every other Wednesday" with no dates, "TBD", "times vary", or a page that contradicts itself is a rejection ("times not stated"). Leave out anything ambiguous. Never put a person's email address or phone number in a record or a verdict.

5. **Turn recurring rejections into rules.** When several leads were rejected for the same reason, make it a rule in `src/social/leads.mts`, cheapest first: a page pattern in `NOT_PAGES`, a wording in `NOT_WORDING`, or a seed's scope in `scripts/leads.mts`, with a case in `tests/social/leads.test.mts`. Run the scanner again to see the rule leave them out.

6. **Check and report.** Run `npm run typecheck` and `npx vitest run tests/social`. Then report: how many leads `leads.md` had, how many were accepted and rejected (the noise rate), the series added, updated and removed, and the rules added. Commit `curated.json`, `leads-seen.json` and any rules; `leads.md` is not committed.
