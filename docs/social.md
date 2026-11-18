# Social: events and pins

The smallest version of the social layer in the model research (`notunh-model-research/social/`), on one shape and one place model. Read with [reminders.md](reminders.md) for the device id and secret, [storage.md](storage.md) for what's kept, and [worker.md](worker.md) for the routes.

## One shape, one place

Everything is an **event** (`src/social/event.mts`): a title, a window (`start`, `end`, epoch ms), a **place**, free text saying **where** exactly, a source, and a URL. Official events are made by the build; a **pin** is one a person makes, kept by the Worker with a description and standing (`Pin`). The home's week, the map's markers, Directions, the `/p/` page and the story image read this shape alone. Copy says "event" for both; "pin" is only the code's name.

A place is a **gazetteer name** (`src/places/gazetteer.mts`), never coordinates: pins are vague by design, at a building or named outdoor place, with the room or lawn in `where`. `placeOf` resolves a name to the place of that name nearest the middle of campus, as search does. The Worker never sees a coordinate.

## Official events

`scripts/map/events.mts` fetches five public calendars and Wildcat Link's clubs nightly (`scripts/data.mts acquire`), each read by `src/social/sources.mts`:

| Source | Fetched | Kept |
|---|---|---|
| Presence (Wildcat Link), `api.presence.io/unh/v1/events` | Whole, one request | All but virtual events |
| 25Live Publisher (UNH's calendar), `25livepub.collegenet.com/…/university-of-new-hampshire-events.json` | Three weeks, a request each (its cap is 200 entries) | Not online, cancelled, all-day, training, academic deadlines, or UNH Manchester |
| Athletics (Sidearm), `unhwildcats.com/calendar.ashx/calendar.ics` | Whole, one request | Home games in Durham, not postponed |
| Club Sports (DSE Rec), `unh.dserec.com/api/clubsports/online/events/list` | Three weeks, one request, without our User-Agent | Home events on campus, pending or approved; not away, off campus, or cancelled |
| Campus Rec programs (Innosoft Fusion), `crec.unh.edu/Program?classificationId=`, `GetProgramDetails`, then `GetProgramInstances` or `GetOfferingsForSemester` | Each program its index's classifications list, but staff training, birthday parties, pool passes and sport clubs (DSE Rec's); its page, then its sessions where it's scheduled by calendar, else its offerings in each semester the page names | Sessions and offerings with spots left, not cancelled, with a day and time |

DSE Rec's list is the JSON its public club pages ask for, without sign-in; rosters and members are never asked for. A club's event is titled by club, then type where the name doesn't say it ("Tennis: Practice", "Men's Soccer game: Maine"), linking to the club's events page. DSE writes a repeating practice as its first session's start with the series' last day as its end, so an end on a later day is read as that time of day after the start (`sessionOf`), which also reads a weekend tournament as its first day; a session listed twice is kept once.

Venues are placed by `src/social/aliases.mts`: the longest gazetteer name in the text wins, after an alias table (MUB, PCAC, T-Hall, Ham Smith, HoCo, Lundholm, Swasey…); a calendar-only 25Live entry is placed by its description. Of the research's sample, 95 of 100 Presence events, 19 of 24 student-relevant 25Live events, and every home game were placed; of three weeks of club home events, 39 of the 59 naming a venue. The UNH Tennis Courts have no name in OpenStreetMap, and Studio 1, "Lower" and Mendums Pond are unplaced too. An unplaced event is listed with its text and no marker.

The result is `src/map/events.json`, a map data file like the timetable; a generation of inputs without it gets an empty list. `tests/fixtures/events/` holds trimmed copies of each calendar's answer.

**Clubs' meetings** come from Wildcat Link's clubs (`api.presence.io/unh/v1/organizations`), each with the meeting time and place its page shows: of 353 clubs, 155 give a time. Only those two fields are read, never a club's description, which names its members. A time naming weekdays and one time, read by the one reader of times as people write them (`src/social/when.mts`, the leads' and Campus Rec's too), is a meeting each of those weekdays: "Tuesdays from 5:00-6:00 PM", "2:10-3:30pm on Friday", or "Mondays at 8PM", which gives no end and so is told by its start alone. One that isn't every week ("Bi-weekly", "Selected Thursdays", "Last Week of Every Month", "TBD"), every weekday, or longer than four hours (an office's hours) isn't told. Clubs meet on class days (`classDays` in `src/courses/calendar.mts`): within a term that's begun, before its last day of classes, and not on a day without classes, as the academic calendar the courses step read that night says, so `scripts/data.mts` runs the courses before the events. A meeting is titled "<club> meeting", id `presence:<club>/meeting/<day>`, and links to the club's page. Of the first night's clubs, 82 meet weekly, 219 meetings over three weeks, 163 placed. Every club is also kept in `events.json`'s `orgs` (`fromPresenceOrgs`), whether or not it posts a time: its name, page, stated meeting time and place as words, and Wildcat Link's categories, never its description or members, so Clubs & activities lists those that haven't posted a meeting too.

**Campus Rec's programs** are scheduled one of two ways. One scheduled by calendar (Open Skate, Stick & Puck, group exercise classes) has sessions, which its page reads from the appointments `GetProgramInstances` answers, each a start and end on the local clock, a room, and the class's size and how many registered; a session is an event, told by its appointment's id and start, as a series' sessions share one id, and placed by its room, Campus Rec's own studios, kitchen and courts being the Hamel Rec Center's and its rink the Whittemore Center's. One scheduled by offering says when in its offerings' titles ("Saturday 11/7 (10am-4:30pm): Pancakes on Mt. Major", "Saturday 9/5 11:30am Departure", a time alone an hour long), read as a club's meeting time is, in the year of the semester listed, or else in the first row of the offering's schedule ("Fri, Nov 20 2026", "6:00 - 8:00 PM", "Swasey Indoor Pool"), a course over several days or weeks read as its first session, as signing up is for all of it; what they are is the rest, without who leads them, and "Honors students:" where only they may go. Each is placed by its title, else where its program says it meets, and carries how many spots are left (`left`) and when signing up closes (`closes`); its row says the spots, its page both, beside a **Sign up** that opens the program's page, as signing up takes UNH's sign-in.

**Games and practices** (`src/social/sport.mts`): the calendars tell some of the same things in their own words, so each event is read the same whatever its source. A practice, hold, camp, rehearsal, tryout, training or closed session goes on there but isn't for going to; a game, meet, match or tournament is, as is anything from Athletics or a person's own event. The same game told by two calendars (the same place, starting within half an hour, the same team's gender, most of one's words in the other's) is told once, as the surest calendar tells it (Athletics, 25Live, DSE Rec, Campus Rec, Presence, UNH's website), with the others' ids in `also`, so a link by any of them opens it; this is `merged`'s last step, the same whatever order and again on its own answer. A club's meeting and the 25Live room booked for it are one too (`isSameMeeting`: the same place, overlapping times, and at least three quarters of the booking's words, less the term's, in the club's name), the meeting kept with the booking's id in `also`. The map draws a place with only practices on smaller and fainter, labelled by a game where there's one.

**What recurs** (`src/social/series.mts`): a club's meetings, a Campus Rec class, a sport club's practices and a curated series are each one activity, known by a key read from a session's id or link (`seriesOf`). `directory()` is the one test of what's an activity: a series with sessions to come that recurs (a club's meeting always, anything else once it's on in two weeks), plus every other club in `orgs`; only what it lists is followed, folded, or told once in search. Lists show what's on once as rows, soonest first, and fold each kind of what recurs into one line ("Club meetings · 25 today" over "Next: …") that opens to show each and stays open on coming Back, the kind whose next starts sooner first; practices always fold, last; what's yours always keeps its row.

## Only on UNH's pages

Some things happen again and again with no calendar telling them: language conversation hours, open climbs, drop-ins. **Curated series** (`src/social/curated.json`, read by `src/social/curated.mts`) are kept by hand: each a title, where as its page writes it (placed as a venue is), its sessions, the page it's from, the passage its times were read from word for word, and the day someone last read it (`checked`). A session is a rule saying its days ([recurrence.md](recurrence.md)), the dates its page names where it names them, else its wording ("every Friday", "biweekly Wednesdays" from a day it's on), with a start and an end, so a café on Tuesdays at one time and Thursdays at another is one series; every rule has a last day, usually the term's, so one nobody checks again ends on its own. A build lists each series' sessions over the same three weeks as the calendars as it installs the events (`tellCurated` in `scripts/inputs.mts`), not the night's run, so an edit is on the site the next deploy, as source `curated`, ids `curated:<title>-<day>-<start>`; an event's page links its page as "UNH's website · checked Nov 16", its served page says so under "Listed on", and its Calendar line adds the one session or subscribes to the series.

**Leads** are found by `scripts/leads.mts`, with no model: it crawls the sections it seeds from (student life, the language department, the library, Campus Rec, the arena, and the offices students drop in on), breadth first within each, three links deep, two requests at a time with a pause, as robots.txt allows, asking again only for what changed (ETag, Last-Modified, kept in `node_modules/.cache`), and leaving a host alone that refuses or challenges it. Each passage of a page's `<main>` that states a time of day (a weekday or a date with a time, or a range) is read by our own patterns (`src/social/when.mts`) into its days, times and dates, its days proposed as a rule where they read as one (the dates it names, else "first Tuesday" or "every Friday"; none where it says every other week and names no day to count from), placed by the gazetteer, and scored (`src/social/leads.mts`): up for "every" and plural weekdays, words of things to go to (hour, table, drop-in, open, workshop, skate…) and a place, down when every date it names is past. What isn't one is left out, cheapest first: people's pages, the catalog, admissions, policies and news over a term old by address; course codes of the registrar's subjects, credits, prerequisites, offices' hours and deadlines with no window by wording; a class meeting at its place, weekday and time; what a calendar or a series already tells; and passages judged before (`leads-seen.json`, by a hash of the passage, accepted or rejected with a reason), so a run asks only of what's new or changed. Addresses are dropped from every passage. What's left is `leads.md` (not committed), page by page, which `/refresh-events` (`.claude/commands/refresh-events.md`) judges: accepting into `curated.json`, rejecting with a reason, bumping `checked` on series whose pages still say so, never guessing a time, and turning rejections that recur into rules.

## On the map

`src/map/state/today.mts` joins the build's events with the public pins the Worker lists for the four weeks from today (`GET /api/pins?day=&days=`). Each place with something on today is one marker (`events` in `src/map/render/layers.mts`), labelled by what's on: "Tennis · till 3:00 PM" filled while on, "Soccer · 3:00 PM" outlined before. A marker opens the place's page; a row opens the event's, `/map/event/<id>`, whose Directions plans getting there by its start (`planVisit` in `src/map/state/trip.mts`), and whose Remind and parking are the visit's. A pin whose time is still to pick says "To pick" and isn't drawn. The week's page (`/map/week`) lists both a day at a time. What's yours labels its place first, larger and in gold, from further out.

## Saves, follows and Yours

What you tap decides what's kept (`src/social/saves.mts`, the synced key `events-saved`, `{ sessions: { id: end }, follows: [key] }`). A dated row's star, or an event page's **Save**, saves that one session, let go once it's over; saved from an activity you don't follow, a notice offers to follow it. An activity's page (`/map/activity/<key>`) has **Follow**, which keeps only the key, so it outlasts weeks with nothing posted. Neither is inferred from the other. A session is found by its own id or any in `also`, so a save made before two tellings merged keeps working. **Going** stays on people's own events, which have no star. Yours is computed each time from saves, follows and Going (`state.yoursNext`, `src/map/state/saves.mts`), never written back.

**Clubs & activities** (`/map/explore`, `src/map/ui/Explore.tsx`) is the directory, filtered first by whether you could go (meets today, drop-in, a day, a time of day), then by interest; each row gives the next matching session and how to join. An activity's page says who runs it, when it meets, how to join, its next sessions, Follow, and **Subscribe** to every session. **Plan ahead** (`/map/ahead`, `src/map/ui/Ahead.tsx`) lists the term's key dates ([courses.md](courses.md)), home games and what's yours further out, by month, registration windows narrowed by your class standing (`class-standing`); the home links to it from Today and says its next date in Campus. **You** (`/map/you`) lists the sessions saved and the activities followed.

## Pins

Made from **+ New event**, the last row of today on the home, or **+ New event here** on a place's page: `/map/new/<place>` (`src/map/ui/NewEvent.tsx`). What, where (a place the map knows, searched as typed by its name or what people call it, the first found taken once the field is left), where exactly, a day (Today, Tomorrow, or another) with a start and an end, each a chip over its native picker, the end keeping its length as the start moves, up to two more times (**+ Another time**, and **− Remove a time** for the last), details, **spots**, and Link only or Everyone. The form makes the pin's id as it opens, so posting again after a failure is the same pin. Posted, it takes the form's place in the history and opens as `/map/event/<id>`, with Going, the times to mark or set, Share, and in the foot Edit and Delete, asked again in a dialog over the page, or Report (`src/social/ui.tsx`, shared with `/p/`).

The map's event page shows a pin as the Worker last told this device of it, or as the home's list has it, and asks for it again as it opens, since a list never says whose it is or who's going; what a command answers is what the page shows next, and the home's list is asked again after each, as a time set or an event deleted changes it.

**Edit** opens `/map/edit/<id>`, the same form filled with the event as the page last had it, its times as the host sees them (those to pick from while its time is to pick, else the one it's at, `timesToEdit`), saved as **Save** by `PUT /api/pins/:id` and checked as a new one is, its times where they're changed, a public one taking a verified address. Times as they were change nothing of marks, the set time or Going. One time makes it an ordinary event at that time, keeping who's going and dropping the marks. Several are to pick from again: the set time is cleared, nobody is going, and each mark stays on its time where that time is kept, the rest dropped; the form says so. Spots never drop below those going, checked in the same batch as the edit, so a Going taken meanwhile can't be overrun. Saved, it opens as its page again in the form's place. `/p/` links its Edit to the map's.

`/p/<id>` (`p/index.html.tsx`, `src/social/pin.tsx`) is the light page a shared link opens, with no account or install: place, time, **Directions**, **Going** (a count, never a list), **Share**, linking to the map's page. The Worker puts the pin in its head for previews ([deploying.md](deploying.md#search-and-sharing)); the page fills in the rest from `GET /api/pins/:id`.

Pins are **link-only** by default. **Everyone** (public, on everyone's map) takes a verified UNH address. A pin is kept until two hours after its end (`LINGER`), then pruned nightly with everything of its.

### Picking a time

A pin may offer two or three times; the place is the host's. While its time is to pick, its window spans its times, the page says **Time to pick**, and each time has one **mark** per device, toggled: "this time works for me", with a count (`src/social/marks.mts`). The host sees **Set** on each time instead, which makes the pin an ordinary event at that time.

Setting asks only whoever marked that time **"Going?"**: a push, "Set for Thu 4:00 PM · Going?" (`src/social/ask.mts`), to each such device that gave a push subscription, and the same line on the page for one without. Tapping the push opens `/p/<id>#going`, which says Going for that device in one tap; the button takes it back. Set enrolls nobody, and Going is refused until there's a time.

**Going** is a count, of the spots where there are some ("Going · 3 of 4"), and **Full**, disabled, once they're taken. Taking a spot is one conditional insert, so two taps can't both take the last.

A mark asks for push permission the first time, from the tap, where the browser can push (an installed app on iOS). The subscription is kept on the device's row, replaced by its next mark's, and dropped once its push service says it's gone. Remind is the visit's, independent of Going (`RemindSlot` in `pin.tsx`).

### Sharing

**Share** draws a 1080×1920 story image on a canvas (`src/social/story.mts`): title, day and time ("Time to pick" until set), place, a QR code of the link, and the link in words, inside Instagram's safe area. The link goes on the clipboard, and the image through `navigator.share({ files })` where possible, else as a download. The QR encoder is our own (`src/social/qr.mts`, byte mode, level M, versions 1 to 10), checked against CoreImage's bit for bit when written, and by its invariants in tests. A link to an event, `/p/<id>` or `/map/event/<id>`, previews with a card the Worker draws; the story stays on the phone, offline.

## Identity

Everything is done as the **device**: the id and secret reminders use (`src/reminders/browser/store.mts`), made the first time anything is asked. Its first social command sets the secret's SHA-256 in `devices` and makes it a **person** of its own. A device is no longer dropped when pushes stop reaching it; its reminders are.

Every command answers with the `notunh-device` cookie holding the id and secret (`worker/session.mts`): set by the Worker, `HttpOnly`, `SameSite=Lax`, `Path=/api/`, `Secure` over https, renewed for 400 days. A command bearing no secret is the cookie's device, and `GET /api/session` answers the id and secret from it, or nothing (204) where there's none, so a browser whose storage was cleared is still itself ([storage.md](storage.md#your-things-kept-for-you)).

**Your things** (saved sections and trips, permit, laundry rooms, dining hall and filters, your calendar feed's token) are kept per person in `state` via `POST /api/state` (`src/shell/sync.mts`); linked devices share them.

**Linking devices** (`src/map/ui/You.tsx`): the new device asks for a code (`POST /api/link`), eight letters and digits without 0, O, 1, I or L (`src/social/link.mts`), shown as a QR of `/map/#link=<code>` and in letters, good for two minutes, and polls `GET /api/link/:code` every two seconds. Any device of the person scans or types it and approves (`POST /api/link/:code`), which moves the new device, and every pin, address and thing of its person, to the approver's person in one batch (`join` in `worker/social.mts`), each key's newer write kept.

**Verifying a UNH address** (`@unh.edu` or `@wildcats.unh.edu`): `POST /api/email` stores it lower-cased and sends a six-digit code, good for ten minutes and five guesses. It's typed back (`POST /api/email/verify`), or the email's link opens `/map/#verify=<address>:<code>` with a **Confirm** button, which is what sends the code, so a mail filter opening the link can't consume it. Verification lasts a year.

**Recovery.** Verifying an address another person verified within the year joins this device to that person, as linking does (`joined: true`, "Your things are back."), so a wiped device, a new phone, or the Home Screen app beside Safari gets everything back. Whoever reads the inbox can do this, the same trust the code already places in it.

### Sending the code

Through **Cloudflare Email Service** (Email Sending) by its Workers `send_email` binding, `EMAIL` in `wrangler.jsonc` (https://developers.cloudflare.com/email-service/); Email Routing's `send_email` only reaches the account's verified addresses. `worker/mail.mts` sends one plain-text message from `MAIL_FROM` (`codes@notunh.app`, the binding's one allowed sender) as `env.EMAIL.send({ from, to, subject, text })`:

```
Subject: 123456 is your notunh code

123456

Your notunh code, good for 10 minutes. Or open this and tap Confirm:
https://notunh.app/map/#verify=you%40unh.edu:123456

Not you? Ignore this.
```

A refusal (`E_RECIPIENT_SUPPRESSED`, `E_DAILY_LIMIT_EXCEEDED`, …) is logged and answered 502, "Couldn't send the code; try again later". 3,000 messages a month are included, then $0.35 a thousand; a new account starts on a small daily quota that grows with its sending.

Unbound, as in Previews, the message is logged and nothing sent. `wrangler dev` simulates the binding, logging From, To and Subject and writing the text under `.wrangler/tmp/`. Unit tests and the browser tests' Worker (`tests/worker/serve.mts`, `GET /__mail`) bind a fake that keeps what it's given.

**Setting it up for notunh.app** (once, by the account's owner):

1. Dashboard: **Compute → Email Service → Email Sending → Onboard Domain**, pick `notunh.app`, review, **Done**. Cloudflare adds an MX, an SPF TXT and a DKIM TXT on `cf-bounce.notunh.app`, and a DMARC TXT at `_dmarc.notunh.app`; keep only one `_dmarc`, at `p=none` until mail is seen arriving.
2. Once the records verify (minutes, up to a day), send a test from the dashboard to a `@unh.edu` inbox and check Junk: UNH is on Microsoft 365, and a new sending domain may be quarantined. If so, ask UNH IT to allow `codes@notunh.app`.
3. Deploy as usual; no secret is needed, and `predeploy` applies the D1 migrations.
4. `wrangler tail` while sending a code from You: a 200 and no `[mail]` error. If codes fail with `E_DAILY_LIMIT_EXCEEDED`, use Cloudflare's Limit Increase Request Form.

## Moderation

- The Rate Limiting binding bounds commands per address a minute, as for reminders.
- Titles, places and `where` are 80 characters, descriptions 500; a person makes at most 10 pins a day, within four months.
- Reports from two devices hide a pin from everyone (`HIDE`).
- A maker edits their pin, which isn't counted as making one, or deletes it, with everything of its.
- `SOCIAL_OFF` in `wrangler.jsonc` switches features off, each answering 503: any of `pins`, `link`, `email`, `sync` (`/api/state` and `/api/session`).

## Budget

At a few hundred users a day: the home asks `GET /api/pins?day=&days=` once a map load (say 2,000), pin pages are opened from links (say 1,000, a page and a read each), commands are a few hundred, a link code polls 60 times, and sync is a request a load, return or write for a device with anything saved or a cookie (say 3,000). Under 10,000 requests and a few thousand D1 writes a day, beside the crons' 3,000: a sliver of Workers Paid's 10 million requests and 50 million rows written a month, and mail within Email Service's 3,000. D1 holds everything; one pin per id and one mark per device per time are primary keys, and the last spot is one conditional insert, so no Durable Object is needed.

## Left out on purpose

Offers and matching, check-ins, threads, follows, recurring pins, images, candidate places, weighted marks, a push when the host moves or cancels, Snapchat's Creative Kit, passkeys, an admin page, and a deny-list. Each is a feature over the same shape and tables.
