# Recurrence and calendars: when things happen again

One model of when something recurs, for curated series, classes, clubs' class days, Campus Rec's bookings, and a calendar someone imports, with iCalendar read and written through it. Read with [social.md](social.md) for events and series, [courses.md](courses.md) for classes, and [storage.md](storage.md) for what's kept.

## Rules

A **rule** is a set of days (`src/shared/recur.mts`), the same shape in JSON and in code, made of a few that compose:

| In code | In JSON | Its days |
|---|---|---|
| `weekly("Tue", "Thu")` | `{ "weekly": ["Tue", "Thu"] }` | Those weekdays, every week |
| `nth(1, "Tue")`, `nth(-1, "Fri")`, `nth(15)` | `{ "nth": 1, "weekday": "Tue" }`, `{ "nth": 15 }` | The first Tuesday of each month, the last Friday, the 15th; negative counts from the month's end |
| `on("2027-02-23", …)` | `{ "on": […] }` | The days named |
| `any(a, b)` | `{ "any": [a, b] }` | The days of either |
| `except(a, b)` | `{ "of": a, "except": b }` | a's days but b's |
| `between(from, until, a)` | `{ "of": a, "between": [from, until] }` | a's days from a day to another, both included; with no `until`, from a day on |
| `every(2, a, anchor)` | `{ "of": a, "every": 2, "from": anchor }` | a's days in every other week, counted from the week the anchor is in (weeks start Monday); `"unit": "day"` or `"month"` counts those instead |

`occurs(rule, day)` is the one evaluator, `occurrences(rule, from, days)` lists a rule's days, and `occursOn(day)` asks many rules about one day, as a day's classes do. A **session** is a rule with a start and an end, times of day on the clock of wherever it is, and the nights it runs through where it ends on a later day; `spanOn` makes it instants once a zone is named. Days and times stay apart until then, so a class at 1:30 is at 1:30 whatever the clocks did that morning: a time the clocks skip in spring is read an hour on, and one they repeat in autumn is the first.

What's on rules:

- **Curated series** (`src/social/curated.json`): each a list of sessions, so Le Café Français is one series with a Tuesday time and a Thursday time. A session's days are the dates its page names where it names them, `on(…)`, however it words how often, and its wording as a rule only where it names none, as "biweekly Wednesdays" is `every(2, weekly("Wed"), …)` from a day it's on. Every session's rule has a last day.
- **Classes** (`sessionOf` in `src/courses/course.mts`): a meeting is `between(its dates, meetingRule(calendar, its weekdays))`, and `meetingRule` (`src/courses/calendar.mts`) is the academic calendar's word on those weekdays: the weekdays and the days swapped to one of them, but the no-class days and the days swapped to another. A section's page, a room's schedule, your week, reminders and the calendar file all ask that one rule.
- **Class days** (`classDays`), which clubs' meetings fall on: any term's days from its start to its end, but the no-class days.
- **Campus Rec's bookings** (`src/courses/rec.mts`): Fusion's recurrence rules, read as iCalendar's are.
- **An imported calendar** (`src/courses/imported.mts`).

## Temporal

Days, times of day and zoned moments are [Temporal](https://tc39.es/proposal-temporal/docs/)'s: `PlainDate` for a rule's days, `PlainTime` for a session's times, `ZonedDateTime` for an occurrence, in `America/New_York` or an imported event's own zone. `src/shared/temporal.mts` is the one place it comes from: the engine's own `Temporal` where it has one, else [temporal-polyfill](https://github.com/fullcalendar/temporal-polyfill) (pinned). No released Safari has it (the floor is 16.4), nor Node 26, nor workerd at this compatibility date; Chrome, Firefox and WebKit's own builds since have it.

- **The Worker, the scripts and the tests** import the polyfill as they load, through `#temporal` in `package.json`'s `imports`, so nothing there waits for it.
- **A page** gets nothing from `#temporal` (its `browser` condition is `src/shared/no-temporal.mts`), and the polyfill is a chunk of its own (57 kB, 19 kB gzipped) that only `loadTemporal()` fetches, where the engine has no `Temporal`. A page awaits it before the first thing that asks a rule, of which there are two: the courses loading (`loadTerm` in `src/courses/browser/terms.mts`) and a calendar imported (`src/map/state/calendars.mts`). So no page waits for it to start, and one that never opens a class never fetches it. Before then `Temporal` is undefined there, and anything new that asks a rule on a page must come after one of those two or await `loadTemporal()` itself.
- **Nothing awaits as a module loads.** Safari through 26 runs a module before one it imports has finished awaiting, where several import it ([bug 242740](https://webkit.org/b/242740)), and a bundler hoists such a module into a chunk every page shares.

A page's head names the chunk as `<link rel="polyfill" data-for="Temporal">`, which no browser fetches for being named, and the release manifest (`src/shell/manifest.mts`) counts it as the page's code only where there's no such global, so the service worker keeps it for offline exactly where it's needed. The browser tests' engines both have Temporal, so one test takes it away to go through the polyfill (`tests/browser/calendar.browser.mts`), as every unit test does in Node.

`src/shared/time.mts` stays as it was, on `Intl` alone: a `Day` is still the `YYYY-MM-DD` text every boundary uses, and nothing the service worker imports may import Temporal. Recurrence, sessions and calendar files use Temporal; the timetable, menus, laundry and parking still use `time.mts`.

## iCalendar

`src/shared/ics.mts` is the one reader and writer, with no library: published parsers (ical.js, node-ical, rrule) are 50 kB and up, carry their own date and zone models beside Temporal, and expand rules into instants rather than giving back days and times apart, which is what rules need. What's read here is small: lines unfolded, properties with their parameters, text unescaped.

**Reading.** Only what's at a time of day: a VEVENT on whole days, as a due date or a birthday is, isn't read. A VEVENT is a session in its own zone: its `TZID` where that's a zone the engine knows or one of Windows' names for one ("Eastern Standard Time", as Outlook writes), UTC for a time ending in `Z`, else Durham's, as a floating time means wherever it's read. An RRULE becomes a rule: `DAILY`, `WEEKLY` and `MONTHLY` with `INTERVAL`, `BYDAY` (ordinals too), `BYMONTHDAY`, `BYSETPOS` over one weekday, `WKST`, `UNTIL` and `COUNT`, which is counted once into a last day. A rule's days start at `DTSTART`, which counts only where the rule falls on it. `EXDATE`s are excepted and `RDATE`s added, by day; an instance moved (`RECURRENCE-ID`) is excepted from its series and read as its own event; a cancelled one is left out. A rule the rules can't say (`YEARLY`, `BYMONTH`, `BYWEEKNO`, `BYYEARDAY`, times within a day, `BYSETPOS` over several weekdays) is read as its first day alone, never guessed at. Athletics' calendar, Campus Rec's rules and an imported calendar are all read this way.

**Writing.** Only a rule with a first and a last day is written, as every one here has: an event's day, a curated session's rule, a meeting's dates. A rule's *skeletons* are the parts of it one RRULE can say, found through `any`, `except` and `between`:

| Rule | RRULE |
|---|---|
| `weekly(days)` | `FREQ=WEEKLY;BYDAY=…` |
| `every(n, weekly(days), anchor)` | `FREQ=WEEKLY;INTERVAL=n;WKST=MO;BYDAY=…` |
| `nth(k, weekday)`, `nth(k)` | `FREQ=MONTHLY;BYDAY=kXX`, `FREQ=MONTHLY;BYMONTHDAY=k` |
| `between(from, until, …)` over any of these | `UNTIL`, the last instant of that day in UTC, and where `DTSTART` may be |

Each skeleton is one VEVENT whose `DTSTART` is its first day the rule really falls on, which also sets the phase of an interval. Then the rule itself is asked about every day in its span: a skeleton's day the rule doesn't fall on (an `except`, or a day an earlier skeleton already told) is an `EXDATE`, and a day no skeleton tells is a VEVENT of its own, under the entry's `UID` and that day, never an `RDATE`, which Outlook doesn't read. So a file always says exactly the rule's days however it's composed, and whatever one RRULE can't say costs a VEVENT a day: a section with two patterns is two VEVENTs and one more for a day swapped to its weekday, a list of dates one each. Times are Durham's under a `VTIMEZONE`, lines fold at 75 octets, and the first VEVENT of an entry keeps its `UID` for good.

## Calendars out

`worker/calendar.mts` serves files made as they're asked for, from the site's own data, so one subscribed to follows a room change:

| Route | |
|---|---|
| `GET /api/calendar/event/<id>.ics` | One event: UNH's as listed, or a person's, which whoever has its link may read |
| `GET /api/calendar/series/<slug>.ics` | A curated series, every session |
| `GET /api/calendar/section/<term>/<crn>.ics` | A section's meetings, holidays, breaks and swap days and all |
| `GET /api/calendar/feed/<token>.ics` | A person's feed: the sections they've saved in the terms not over, and the events they host or are going to |

Each is `text/calendar`, shown inline rather than as an attachment, under a name of its own. An event's and a section's page has a **Calendar** line (`CalendarLine` in `src/map/ui/Calendars.tsx`): **Add** opens the file, which Safari on iOS offers to add to Calendar and other browsers download for the calendar app to open; **Subscribe**, on a section's page and a curated series' session's, is the section's or the series' address as `webcal://`, which iOS, macOS and Android hand to the calendar app as a subscription. A one-off event has nothing to subscribe to, so only Add. In an iOS Home Screen app, which has nowhere to show a file, Add subscribes too.

**Your feed** (My courses, in You): **Subscribe** and **Copy link**, the https address for a calendar that asks for one, as Google's does. Its token is 128 random bits made on the device the first time it's asked for, kept as `calendar-feed`, one of your things ([storage.md](storage.md#your-things-kept-for-you)), so linked devices share it, and sent to the Worker before any calendar app asks by it. The Worker finds the person by the token alone, through an index on that one key's values. **New link** makes another, which ends the old address. The address is a capability: whoever holds it reads your saved classes and the events you're going to, nothing else. A calendar app can only ask by a URL, so the token is in one, and Cloudflare's request logs hold it as they hold any path, for whoever runs the account to see; nothing the Worker writes itself does, and New link ends it.

## A calendar in

**My calendar**, in You, takes a feed's address (Canvas, Google, Outlook) or an `.ics` file. Each VEVENT at a time that isn't long over is kept as its title, where, zone and session; whole-day entries, as due dates and birthdays are, aren't read, as neither is somewhere to be at a time. Its events are in your week beside your saved classes, and the next of them is a row of Yours.

- **Matching** (`createMatcher`), made as it's shown, never stored: the section an event is a meeting of, by the course code in its title ("CS 518", "[CS518.01-FA26]" as Canvas writes it), its section number where it gives one, else whichever section of the course meets when the event does; with no code, the section meeting in the room it names at that time. Its place is the registrar's for a where in the registrar's words, else what the gazetteer's matcher makes of it, else its section's. A matched class opens its section's page, and one that's saved too is told once.
- **Privacy.** An imported calendar is kept in `localStorage` on the device alone (`calendars`), never synced, never kept by the Worker, and nothing of it reaches PostHog. A feed's address holds a secret, so it's kept only there too, and only an https address is ever asked for: anything else typed is refused on the page, as it would otherwise be asked of this site as a path, and logged.
- **Fetching.** The browser asks the address itself first, without credentials or a referrer, which works where the host allows any origin. Canvas', Google's and Outlook's don't, so it falls back to `POST /api/calendar/fetch` with the address in the body: the Worker fetches it and hands the text straight back, keeping, caching and logging nothing, so the address and the calendar pass through the Worker but stay nowhere. It asks only an https address of a public host by name, on the default port, with no credentials: never an IP address in any spelling, a single-label or reserved name (`.local`, `.internal`, `.localhost`…), or this site; redirects are followed by hand, three at most, each checked the same; the answer must start as a calendar and be under 2 MB within ten seconds; and the Rate Limiting binding bounds it per address.
- **What that guard can't promise.** It's on the address, which is all a Worker sees: it can't resolve a name, so a public name that points at a private address, or is changed to between two asks, passes it. What stands behind it is Cloudflare's network, which gives a Worker's fetch no loopback, metadata address or private network unless one is bound, and none is. Under `wrangler dev` and the tests' Node server there's no such floor.
- A calendar from an address is read again when it's over six hours old, as You opens.

## Left out on purpose

Whole-day imported events (one at a time that runs past midnight is kept, on the day it starts), attendees and alarms, VTODO and VJOURNAL, a VTIMEZONE's own rules (a zone is known by name or not at all), yearly rules, `RDATE`s at another time of day than their event's or given as a period, a `TZID` naming a zone by a longer id than its own, writing an `RDATE` or a rule with no last day, and writing in any zone but Durham's.
