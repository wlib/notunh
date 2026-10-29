# Social: events and pins

The smallest version of the social layer in the model research (`notunh-model-research/social/`), on one shape and one place model. Read with [reminders.md](reminders.md) for the device id and secret, [storage.md](storage.md) for what's kept, and [worker.md](worker.md) for the routes.

## One shape, one place

Everything is an **event** (`src/social/event.mts`): a title, a window (`start`, `end`, epoch ms), a **place**, free text saying **where** exactly, a source, and a URL. Official events are made by the build; a **pin** is one a person makes, kept by the Worker with a description and standing (`Pin`). The home's week, the map's markers, Directions, the `/p/` page and the story image read this shape alone. Copy says "event" for both; "pin" is only the code's name.

A place is a **gazetteer name** (`src/places/gazetteer.mts`), never coordinates: pins are vague by design, at a building or named outdoor place, with the room or lawn in `where`. `placeOf` resolves a name to the place of that name nearest the middle of campus, as search does. The Worker never sees a coordinate.

## Official events

`scripts/map/events.mts` fetches four public calendars nightly (`scripts/data.mts acquire`), each read by `src/social/sources.mts`:

| Source | Fetched | Kept |
|---|---|---|
| Presence (Wildcat Link), `api.presence.io/unh/v1/events` | Whole, one request | All but virtual events |
| 25Live Publisher (UNH's calendar), `25livepub.collegenet.com/…/university-of-new-hampshire-events.json` | Three weeks, a request each (its cap is 200 entries) | Not online, cancelled, all-day, training, academic deadlines, or UNH Manchester |
| Athletics (Sidearm), `unhwildcats.com/calendar.ashx/calendar.ics` | Whole, one request | Home games in Durham, not postponed |
| Club Sports (DSE Rec), `unh.dserec.com/api/clubsports/online/events/list` | Three weeks, one request, without our User-Agent | Home events on campus, pending or approved; not away, off campus, or cancelled |
| Campus Rec programs (Innosoft Fusion), `crec.unh.edu/Program/GetProgramDetails` then `GetOfferingsForSemester` | Each program in `REC_PROGRAMS` (Outdoor Adventures trips, the Mendums Pond shuttle, pool kayaking, night skiing), its page then its offerings in each semester the page names | Offerings with spots left and a day and time in their title |

DSE Rec's list is the JSON its public club pages ask for, without sign-in; rosters and members are never asked for. A club's event is titled by club, then type where the name doesn't say it ("Tennis: Practice", "Men's Soccer game: Maine"), linking to the club's events page. DSE writes a repeating practice as its first session's start with the series' last day as its end, so an end on a later day is read as that time of day after the start (`sessionOf`), which also reads a weekend tournament as its first day; a session listed twice is kept once.

Venues are placed by `src/social/aliases.mts`: the longest gazetteer name in the text wins, after an alias table (MUB, PCAC, T-Hall, Ham Smith, HoCo, Lundholm, Swasey…); a calendar-only 25Live entry is placed by its description. Of the research's sample, 95 of 100 Presence events, 19 of 24 student-relevant 25Live events, and every home game were placed; of three weeks of club home events, 39 of the 59 naming a venue. The UNH Tennis Courts have no name in OpenStreetMap, and Studio 1, "Lower" and Mendums Pond are unplaced too. An unplaced event is listed with its text and no marker.

The result is `src/map/events.json`, a map data file like the timetable; a generation of inputs without it gets an empty list. `tests/fixtures/events/` holds trimmed copies of each calendar's answer.

**Campus Rec's programs** say when they are only in their titles ("Saturday 11/7 (10am-4:30pm): Pancakes on Mt. Major", "Saturday 9/5 11:30am Departure", a departure an hour long), in the year of the semester listed; what they are is the rest, without who leads them, and "Honors students:" where only they may go. Each is placed by its title, else where its program says it meets, and carries how many spots are left (`left`) and when signing up closes (`closes`); its row says the spots, its page both, beside a **Sign up** that opens the program's page, as signing up takes UNH's sign-in.

**Games and practices** (`src/social/sport.mts`): the calendars tell some of the same things in their own words, so each event is read the same whatever its source. A practice, hold, camp, rehearsal, tryout, training or closed session goes on there but isn't for going to; a game, meet, match or tournament is, as is anything from Athletics or a person's own event. The same game told by two calendars (the same place, starting within half an hour, the same team's gender, most of one's words in the other's) is told once, as the surest calendar tells it (Athletics, 25Live, DSE Rec, Campus Rec, Presence), with the others' ids in `also`, so a link by any of them opens it; this is `merged`'s last step, the same whatever order and again on its own answer. Lists gather a day's practices at a place into one muted line at the end ("2 practices" over "Baseball, Softball · Student Rec Field") that opens to show each, so a list of what's on isn't a list of practices and a field with only practices still says something's on; the map draws a place with only practices on smaller and fainter, labelled by a game where there's one.

## On the map

`src/map/state/today.mts` joins the build's events with the public pins the Worker lists for today (`GET /api/pins?day=`). Each place with something on today is one marker (`events` in `src/map/render/layers.mts`), labelled by what's on: "Tennis · till 3:00 PM" filled while on, "Soccer · 3:00 PM" outlined before. A marker opens the place's page; a row opens the event's, `/map/event/<id>`, whose Directions plans getting there by its start (`planVisit` in `src/map/state/trip.mts`), and whose Remind and parking are the visit's. A pin whose time is still to pick says "To pick" and isn't drawn. The week's later days list the build's events only.

## Pins

Made from **+ New event**, the last row of today on the home, or **+ New event here** on a place's page: `/map/new/<place>` (`src/map/ui/NewEvent.tsx`). What, where (a place the map knows, searched as typed), where exactly, a day with start and end, up to two more times (**+ Another time**), details, **spots**, and Link only or Everyone. The device makes the pin's id, so a retry is the same pin. Posted, it opens as `/map/event/<id>`, with Going, the times to mark or set, Share, and Delete or Report (`src/social/ui.tsx`, shared with `/p/`).

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

Every command answers with the `notunh-device` cookie holding the id and secret (`worker/session.mts`): set by the Worker, `HttpOnly`, `SameSite=Lax`, `Path=/api/`, `Secure` over https, renewed for 400 days. A command bearing no secret is the cookie's device, and `GET /api/session` answers the id and secret from it, so a browser whose storage was cleared is still itself ([storage.md](storage.md#your-things-kept-for-you)).

**Your things** (saved sections and trips, permit, laundry rooms, dining hall and filters) are kept per person in `state` via `POST /api/state` (`src/shell/sync.mts`); linked devices share them.

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
- A maker deletes their pin, with everything of its.
- `SOCIAL_OFF` in `wrangler.jsonc` switches features off, each answering 503: any of `pins`, `link`, `email`, `sync` (`/api/state` and `/api/session`).

## Budget

At a few hundred users a day: the home asks `GET /api/pins?day=` once a map load (say 2,000), pin pages are opened from links (say 1,000, a page and a read each), commands are a few hundred, a link code polls 60 times, and sync is a request a load, return or write for a device with anything saved or a cookie (say 3,000). Under 10,000 requests and a few thousand D1 writes a day, beside the crons' 3,000: a sliver of Workers Paid's 10 million requests and 50 million rows written a month, and mail within Email Service's 3,000. D1 holds everything; one pin per id and one mark per device per time are primary keys, and the last spot is one conditional insert, so no Durable Object is needed.

## Left out on purpose

Offers and matching, check-ins, threads, follows, recurring pins, images, candidate places, weighted marks, a push when the host moves or cancels, Snapchat's Creative Kit, passkeys, an admin page, and a deny-list. Each is a feature over the same shape and tables.
