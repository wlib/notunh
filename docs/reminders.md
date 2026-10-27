# Reminders: when to leave, by Web Push

"Remind me" on a chosen itinerary, on walking the whole way, or on any visit (an event, a class, a place and a time) pushes to the phone when it's time to go.

- **The phone plans**: the trip, whatever its shape (walked, a walk and a bus, buses with a change, a long walk then a bus), leaving now or to arrive by a time, with the walks' allowances, when to leave (the itinerary's own start), how long before the first bus to wake, and what the notification says.
- **The Worker watches one time**: when to wake the phone, as a time and a lead before it, and where a bus makes that uncertain, the first bus's run (trip, scheduled time, stop). It forecasts that run with the map's model from the fixes it already records. With no run, as for a walk, it wakes the phone once at the time less the lead.
- **The Worker never learns** where the trip goes or comes from, or what class it's for. The lead is the walk plus the heads-up, to the half minute, so it does say about how far the first stop is.

## How it works

1. **The phone sets the reminder.** `src/map/ui/Remind.tsx` builds it from the itinerary (`reminderOf` in `src/reminders/reminder.mts`, pure), with the heads-up chosen (2, 5, 10 or 15 minutes, `HEADS_UPS`) and any time to be there by. `src/map/state/reminders.mts` subscribes to pushes, keeps it, and `PUT`s the watch (`src/reminders/browser/api.mts`, the routes' one client). A trip to leave for within the heads-up and a minute (`isTooSoon`) offers none: its own "leave in" is the reminder.
   - **Kept whole** (`src/reminders/browser/store.mts`, version 3): from and to, the way (`wayKey`), legs (walks with allowance and end, rides with run and stop by id and name, scheduled and expected times), leave and arrival, the time asked, the heads-up, the margin, and its state with the Worker. It's one JSON entry in its own Cache Storage cache, `reminders-v1`, which pages and the service worker share (`localStorage` isn't) and the app's worker never deletes. Every change is read, edited and written under one Web Lock (`navigator.locks`), so two tabs' first reminders get one device id and secret, and a failed read rejects the change rather than overwrite storage. If storage lost the id and secret, they're taken back from the Worker's cookie (`recovered`, `GET /api/session`, [social.md](social.md#identity)) before new ones are made; the reminders themselves are lost with storage, and their watches run out.
   - **Keep first, tell after.** A reminder is kept as `setting` before the Worker is asked and moved to `set` on its 204 only if still `setting` (`transition`), so a cancel meanwhile isn't overwritten; a cancel is `cancelling` until the Worker answers. A refusal (4xx) drops it with the reason; what couldn't be told (offline, 5xx, or 429, as a campus network's few addresses can hit) is asked again under the same id when the map loads or the phone comes online, which the Worker takes as a replace. The service worker words a push for a `cancelling` reminder as cancelled.
   - **The walk** is the first walk leg's allowance (`walkAllowance`: 10 % over a network walk, 30 % over an estimate), as the planner left before the bus, so the leave time is the itinerary's start.
   - **The lead** (`leadTime`): with a bus, the walk to its stop, the heads-up, and a minute more while no bus is on the trip yet, as a whole half minute from 1 to 60 minutes; without, the heads-up alone. The bus's slack isn't in it: the Worker allows that from the forecast's band. Property-tested: the wake is never later than the heads-up before leaving, and a longer walk never moves it later.
   - **The watch** (`watchOf`, `Watch` in `src/reminders/watch.mts`) is `{ at, lead, run? }`: with a run, `at` is the first bus's scheduled departure in epoch seconds and `run` its stop, route and trip id, by which the run is found again under a timetable that renamed its trips (`runOf` in `src/reminders/forecast.mts`); without, `at` is the time to leave.
   - **The margin** is how late the first bus may run before the trip no longer holds: the least of each change's slack (from the first bus's arrival to when the planner counts on catching the next, its departure less its own slack) and what's left before the time asked, or none with neither.
   - `PUT` is rate limited per address by the Rate Limiting binding (`RATE_LIMIT`, 30 a minute per Cloudflare location), since any client can mint device ids, each an object; unbound, as in tests, nothing is limited.
2. **The Worker hands the watch to the device's Durable Object**, one SQLite-backed `Reminders` per device (`worker/reminders.mts`), keeping the subscription, the secret's SHA-256, and each watch with its state. Its one alarm is always the soonest check, the first at once.
3. **Each check forecasts the run** from what the Worker already has:
   - the last 10 minutes of `samples`: every bus fix, and Umo's latest predictions, which say which bus runs which trip and which runs aren't coming;
   - every route's buses followed through the location model and pace (`sightingsFrom` over the `fleet` in `src/transit/models/tracking.mts`), as the map follows live and scoring replays;
   - the day's runs built with `buildRuns`, from the timetable and model the site serves (read via the map page's head once an hour, a minute after a failed read, keeping the last), so a bus going on from another route is followed onto the watched run; then each run looked up (`seenOf`): its departure, band (`slack`), and whether a bus is on it. A run the forecast lacks is `cancelled` if the timetable still has it, and `lost` if not (a timetable swapped since).
   - Without the site's timetable or model, the run is due as scheduled, give or take (`scheduledOnly`). A watch on no run is its fixed time exactly, reading neither the site nor the samples.
   - `src/reminders/watch.mts` decides, purely, when to check again (halving the wait until the bus could leave, band allowed, within the lead, then each minute; a watch on no run goes straight to its wake) and what to push (`check`): `due` once it could; then `update` if the time to be at the stop, band allowed, moves 2 minutes earlier, the bus 2 minutes later, or it's cancelled or lost (a narrowing band is no news); or `over`, once, if the run is gone, or past its scheduled time without ever being near. A forecast placing the bus past the stop before its scheduled time is no news, as a followed bus can be placed ahead of itself on the Gables loop ([transit.md](transit.md)), so a bus that really leaves early is reported missing only after `at + GONE`. A watch pushes at most 3 times, one on no run once.
   - A watch set again under its id on the same run (`replaced`), as a replan moves its lead, goes on as the phone was told, pushes counted, so one bus doesn't wake the phone twice; on another run or time it starts afresh.
   - A push is saved on the watch as owed before it's sent, and alarms run at least once, so an object evicted between sends it next time, never twice. The alarm delivers what's owed, evaluates due watches, then settles (`deliver`, `evaluate`, the handler). A check stamps each watch as found and leaves alone one replaced or cancelled while it awaited samples or the push service.
4. **Pushes are Web Push on WebCrypto alone** (`worker/push.mts`): RFC 8291 encryption (aes128gcm, RFC 8188), RFC 8292 VAPID, RFC 8030 headers.
   - Each carries its shape's version (`v`) and what the forecast says (`Seen` in `watch.mts`): when the bus leaves the stop, how early to be there, whether a bus is on it, whether it's coming, cancelled, lost or past, and when checked. `TTL` runs until the bus is gone, `Urgency: high`, and `Topic` is the reminder, so a newer push replaces an undelivered one.
   - On 404 or 410 the device is forgotten, unless the phone has subscribed anew elsewhere meanwhile. On 429 or 5xx the push stays owed, retried after `Retry-After` or 30 s doubling, and given up after 5 tries or 2 h past the run.
5. **The service worker always shows a notification** (`src/sw/push.mts`), as iOS requires.
   - It words it from the push and the reminder kept (`meaningOf`, `textOf`): when to leave (the bus's time less the walk and band, or the leave time), the first bus at its stop and how late it runs, the walk, and the arrival shifted by the first bus's delay while within the margin, with the time asked ("MUB 9:44, before your 9:50"). Past the margin it says to open notunh: "may miss the 9:31 change", "may be late for 9:50". A walk alone reads "14 min walk to MUB, there 9:40". Cancelled, past, or gone before near: the bus may not be coming. Lost: notunh lost track, as the timetable changed.
   - An unknown `v` shows a plain "Time to head out". Pushes can arrive out of order, so the last shown is kept, and an older push (by `at`) shows it again.
   - It closes the reminder's earlier notification first, since Safari ignores `tag`.
   - A tap brings up an open map as it is, or opens `/map/?reminder=<id>`, which reopens the trip in Directions.
6. **The map plans each reminder still ahead again as it loads** (`replan` in `src/map/state/reminders.mts`, with `plansFor` in `src/map/state/trip.mts`): only one yet to be left for, by a time to come, that no push has told of (`isAhead`); from where you are if it was from there, by its way if still offered, else the best way now, or walking to arrive on time. Where the leave time moved by 2 minutes (`SHIFT`) or the first bus changed, the fresh plan is kept under the same id and `PUT` again. It waits up to 20 s for your location (`located`) and the live buses (`heard`), else skips, so a timetable-only plan doesn't move the leave time for nothing. A replan refused keeps the plan the Worker watches; one that can't be told now is kept `setting`. A walk for now stays as it was. `/map/?reminder=<id>` restores the trip first and drops the link from the URL.

## Visits and class reminders

- **A visit** (`src/shared/visit.mts`) is a destination (a gazetteer name and where in it, like "N343"), a time to arrive by and an offset (at the start, 5 or 10 min before), and the occurrence it's of, kept on the phone. Directions plans it (`planVisit` in `src/map/state/trip.mts`), and Remind sets a reminder from any occurrence's page with nothing saved or marked going, by the best way from where you are (`wayToVisit`: buses within the planner's 4 h horizon, and walking), or, until where you are is known, unplanned. Un-going leaves it. As the map loads, it's planned again by the best way then.
- **A reminder not planned yet** has no legs and leaves the last plan's length before the time (`unplanned`); its watch is a fixed time, which the Worker takes up to 15 days ahead (`FURTHEST_FIXED`), against 36 h for a run.
- **A class reminder** carries a queue (`src/reminders/queue.mts`): the section's next visits, 10 with the current, each with its place (the service worker can't look it up), whether they reach the last meeting, and when the current was moved on to.
  - Once a push of the current visit is shown, the service worker moves on to the next still to come, unplanned, and `PUT`s it under the same id (`moveOn` in `src/reminders/browser/sync.mts`); a push from before the move shows a plain notification, so moving on is idempotent. One past unheard moves on when the map loads.
  - A page showing sections tops every queue up (`topUpClasses` in `src/map/ui/Remind.tsx`) from the section's meetings to its last, replacing what's queued, and the current visit where it's no longer next (a room change), `PUT` under the same id.
  - Drained before the section ends (offline two weeks), the last push adds "That was the last one I knew; open notunh to keep going."
  - The Worker sees a time, a lead, and a run if there's a bus: never a course, section or room. A tap opens directions to the reminder's place as it is then.

## Every trip shape

| Trip | The watch | The push |
|---|---|---|
| Walked the whole way | `{ at: start, lead: headsUp }` | Once, at `at - lead`: "Leave in 5 min · 14 min walk to X, there 9:40" |
| A walk and a bus | `{ at: scheduled, lead: walk + headsUp (+ 1 min while no bus is out), run }` | When the bus could leave within the lead, band allowed; again if it moves |
| A long walk then a bus | The same, the lead capped at 60 min | The same |
| Buses with a change | The first bus's; the margin is the least change's slack | Arrival shifts with the first bus's delay within the margin; past it, "may miss the 9:31 change · open notunh" |
| Arrive by T | As above, planned to leave latest and arrive by T (`planBy`); the margin includes `T - end` | "there 9:44, before your 9:50", or past the margin "may be late for 9:50 · open notunh" |

## Why this shape

- **iOS and iPadOS (16.4+)** push only to Home Screen web apps, ask permission only from a tap, and revoke it from a site whose push shows nothing (https://webkit.org/blog/13878/, https://webkit.org/blog/12945/, https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers). They ignore `tag`, `renotify`, `silent` and `actions` (https://bugs.webkit.org/show_bug.cgi?id=258922), so notifications stack and every push alerts. Hence checking in the Worker, and forecasting with the model rather than relaying Umo: the final "leave" must be right from the server alone, and the model's held-out median error is half Umo's at every lead ([transit.md](transit.md)).
- **Durable Object alarms** get 30 s of CPU an invocation (https://developers.cloudflare.com/durable-objects/platform/limits/) and fire at a time of their own, where a cron fires each minute at best. A watch is some tens of checks, each a request, a row written, and about 10 `samples` rows read. A check's work in Node on an archived weekday (Oct 15, every 20 minutes 8 to 20 h): decoding samples 1 to 6 ms, following the route's buses 2 to 6 ms, forecasting under 1 ms, plus a few ms per instance to parse the timetable and model. Production has run 4 to 5 times slower than Node, so expect 20 to 50 ms; `wrangler tail --format pretty` reports alarms' `cpuTime`.
- **No library sends the pushes.** The one maintained, correct WebCrypto library, `@block65/webcrypto-web-push`, is about as long as `worker/push.mts`, which tests check against RFC 8291's own example; `@pushforge/builder` and `webpush-webcrypto` send the obsolete `aesgcm`.
- **Plain pushes, not Declarative Web Push.** Safari 18.4 hands a `mutable` declarative message to a `pushnotification` event, not `push`, which would skip the phone's wording. Every push is JSON for the `push` handler iOS 16.4 supports.

## What the Worker keeps

| What | Where | Kept |
|---|---|---|
| Push endpoint and keys, SHA-256 of the device secret, last use | The device's `Reminders` object, `device` table | 30 days after the last check, until the push service says it's gone, or `DELETE /api/push/devices/:device` |
| Each watch: a time, a lead, the run if any (trip, stop, route), pushes made, what it last told the phone | `reminders` table | Until the bus has gone by or it's cancelled; a row of the old shape is dropped when the object runs |

PostHog gets only a `reminder_set` event, for those who opted in, unlinked like `trip_planned` (`UNLINKED` in `src/shell/events.mts`): a fresh id and the hour.

Once pushes can't reach the phone (notifications off, subscription gone), the next trip planned tells the Worker to forget the device (`DELETE /api/push/devices/:device`), if it kept reminders, and the phone drops its reminders. The device's id and secret stay, since pins and marks are made as it; its next reminder sets the Worker's secret anew. The object's tables are made on a device's first reminder and dropped when it's forgotten, so asking about an unknown device leaves nothing behind.

## Routes

Public; each device's by its secret as a bearer token. `PUT` is limited to 30 a minute per address (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), besides ten reminders per device.

| Route | |
|---|---|
| `GET /api/push/key` | The VAPID public key, or 404 where reminders aren't set up, as in Previews |
| `PUT /api/reminders/:id` `{ device, subscription, watch }` | Sets a watch, 204. 401 without the secret, 403 for another device's, 409 past 10, 429 past the address's limit, 400 for an endpoint not a push service's (Apple, Google, Mozilla, Microsoft), a time gone or over 36 h ahead (15 days with no run), a run missing its stop, route or trip, or a lead outside 1 to 60 minutes |
| `DELETE /api/reminders/:id?device=` | Cancels one |
| `DELETE /api/push/devices/:device` | Forgets the device |

## Setting it up

The Worker needs a VAPID key pair as secrets; without one, reminders aren't offered. `node scripts/secrets.mts vapid` makes the Worker's pair (via `wrangler secret bulk`, never shown, never replaced, as a new one orphans every subscription) and a separate `.dev.vars` pair, each only where missing; `check` says whether both are there ([deploying.md](deploying.md)). `VAPID_SUBJECT` is a var in `wrangler.jsonc`. The Durable Object migration is tag `reminders-1` (`new_sqlite_classes`) in `wrangler.jsonc`.

## Testing it

- **Unit and property tests** (`npm test`):
  - `tests/reminders/`: the lead's bounds and monotonicity, the leave time as the itinerary's start for every shape, what's too soon, the margin; the watch under random drifts, bands, failed checks and runs cancelled or lost (it always ends, pushes at most 3 times, `due` first or `over` alone, wakes the lead before the bus to within a check, updates for moves and not narrowing bands, retries a refused push with a doubling wait; on no run, exactly once); the forecast on half an hour of real samples (`tests/map/fixtures/buses.json.gz`); a push's meaning and wording (never empty, the destination never in what the Worker sends); the store over in-memory Cache Storage and Web Locks (`store.test.mts`); the page's reminders across tabs over one storage (`client.test.mts`): set, refused, rate limited, cancelled offline, and replanned only for a moved leave time or first bus; class queues (`queue.test.mts`).
  - `tests/worker/push.test.mts`: RFC 8291's example byte for byte, browser-side decryption of random messages, the VAPID JWT, status handling.
  - `tests/worker/reminders.test.mts`: the routes and the Durable Object on a fake state over Node's SQLite (`tests/worker/durable.mts`), with the same samples in a fake D1, the site's files from memory, and the push service stubbed: decrypted pushes, races with replaces and cancels, subscriptions replaced during a 410, restarts between making and sending, failed site reads, give-ups, the address limit, the samples query using the table's key, fixed-time watches, old rows dropped.
  - `tests/shell/push.test.mts`: every push shows exactly one notification, an unknown shape a plain one, an older push the last again.
  - `tests/layers.test.mts`: `src/reminders/` imports only what's beneath it and no browser global; `src/reminders/browser/` keeps and sends.
- **Browser** (`tests/browser/push.browser.mts`, Chromium): plans a ride on the built site's timetable, leaving now, arriving by a time, and walking, sets a reminder on each, and checks what the stubbed Worker is told against Cache Storage; saves the arrive-by trip and opens it from Yours; opens `/map/?reminder=<id>` later, which replans to the same bus and tells the Worker nothing new; delivers a push with DevTools' `ServiceWorker.deliverPushMessage`; and opens the map two hours on, leaving the reminder as it was. The subscription and permission are stubbed, as headless Chromium has no push service, and notifications are recorded as shown.
- **Locally with wrangler:** `node scripts/secrets.mts vapid` once (`.dev.vars` is gitignored); `npm run build`, then `npx wrangler dev --local` serves site, API and Durable Object on http://localhost:8787, its state under `.wrangler/`. The local D1 has samples only if the crons have run (`--test-scheduled`); without, a check falls back on the timetable. A due alarm posts to the subscription's real push service, so a reminder set from Chrome on localhost for a bus a few minutes out runs the whole loop.
- **Real devices:** an iPhone needs the app on the Home Screen from https: notunh.app with the secrets set, or a tunnel to `wrangler dev`. Check the prompt from the tap, one banner per push and whether closing the earlier works, Focus, and airplane mode at the wake. Android Chrome: `tag` replacement.

## Open questions

- **The service worker doesn't replan**: it rewords the stored itinerary with the first bus's time; the map replans when next opened.
- **Later buses of a trip with a change aren't watched**: the margin says whether the change still holds, and past it the push says to open notunh.
- **Rolling back** past this storage: another entry `version` reads as nothing kept but the device, whose old watches run out on the Worker.
- **Previews have no Durable Object binding or secrets**, so reminders are off there and `/api/push/key` 404s; whether wrangler's `previews` block takes `durable_objects` is unverified.
- **Not verified on a device**: whether `close()` works on current iOS; push latency and alarm precision; a check's CPU in production; how a push service counts a message's size (taken as 4 KB of body).
