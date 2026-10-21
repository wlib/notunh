# Reminders: when to leave, by Web Push

"Remind me" on a chosen itinerary, or on walking the whole way, sets up a push to the phone when it's time to go.

- **The phone plans:** the trip, whatever its shape (walked the whole way, a walk and a bus, buses with a change, a
  long walk then a bus), leaving now or so as to be somewhere by a time, the walks with their allowances, when to
  leave, which is the itinerary's own start, how long before the first bus to be woken, and what the notification
  says.
- **The Worker watches one time:** it's told when to wake the phone, as a time and a lead before it, and where a bus
  makes that uncertain, the first bus's run, as its trip and scheduled time at the stop, and the stop. It forecasts
  that run with the same model the map uses, from the bus fixes it already records, and wakes the phone with what it
  foretells. With no run, as for a walk, it wakes the phone at the time less the lead, once.
- **The Worker never learns** where the trip goes or where it's coming from. The lead is the walk plus the heads-up,
  to the half minute, so it does say about how far the first stop is; the home page says so.

## How it works

1. **The phone sets the reminder.** `src/map/ui/Remind.tsx` builds the reminder from the itinerary (`reminderOf` in
   `src/reminders/reminder.mts`, pure), with the heads-up chosen (2, 5, 10 or 15 minutes before leaving) and the
   time to be there by if one was asked, and `src/map/state/reminders.mts` subscribes to pushes, keeps it, and `PUT`s
   the watch to the Worker (`src/reminders/browser/api.mts`, the one client of the routes). A trip to leave for within
   the heads-up and a minute (`isTooSoon`) offers no reminder: its card's own "leave in" is the reminder.
   - The reminder is kept whole (`src/reminders/browser/store.mts`, document version 2): where it's from and to, its
     way (`wayKey`), its legs, each walk with its allowance and where it ends, each ride with its run and stop by id
     and by name and the bus's scheduled and expected times, when to leave and get there, the time asked to be there
     by, the heads-up, the margin, and where it stands with the Worker. It's one JSON entry in a Cache Storage cache
     of its own (`reminders-v1`), which pages and the service worker share and `localStorage` isn't, and which the
     app's worker leaves alone when it drops older caches. Every change is read, edited and written under one Web
     Lock (`navigator.locks`, Safari 15.4+), so two tabs setting their first reminder at once get one device id and
     secret, and a read that fails rejects the change, so nothing is written over what storage may still hold.
     IndexedDB would do the same with transactions and a schema, for more code.
   - **The phone and the Worker are kept agreeing by keeping first and telling after.** A reminder is kept as
     `setting` before the Worker is asked, and moved to `set` once it answers 204 only if it's still `setting`
     (`transition`), so a cancel meanwhile isn't written over; a cancel is kept as `cancelling` until the Worker
     answers. Whatever the Worker refuses (4xx) is dropped with the reason; whatever it couldn't be told (offline,
     5xx, or 429 for too many set from the address, as a campus network's few addresses can be) is asked again with
     the same reminder id when the map next loads or the phone comes back online, which the Worker takes as a replace.
     The service worker words a push for a `cancelling` reminder as cancelled.
   - The walk is the first walk leg's allowance (`walkAllowance`, 10 % over the walk along the network, 30 % over an
     estimate), the same the planner left before the bus, so the leave time is the itinerary's own start.
   - The lead (`leadTime`) is how long before its time to wake the phone: with a bus, the walk to its stop, the
     heads-up, and a minute more while no bus is on the trip yet, as a whole half minute between 1 and 60 minutes;
     without one, the heads-up alone. The slack the bus's time needs isn't in it: the Worker allows that from the
     forecast's band at the time. It's pure and property-tested: the wake is never later than the heads-up before
     leaving, and a longer walk never moves it later.
   - The watch (`watchOf`, `Watch` in `src/reminders/watch.mts`) is `{ at, lead, run? }`: with a run, `at` is the
     first bus's scheduled departure from the stop in epoch seconds and `run` the stop, the route and the trip's id,
     by which the day's run is named and found again under a timetable that has since renamed its trips (`runOf` in
     `src/reminders/forecast.mts`); without, `at` is the time to leave.
   - The margin is how late the first bus may run before the rest of the trip no longer holds: the least of each
     change's slack, counted from the first bus's arrival to when the planner counts on catching the next, which is
     its departure less the slack its own time needs, and of what's left before the time asked, or none with neither.
   - `PUT` is rate limited by address through the Workers Rate Limiting binding (`RATE_LIMIT` in `wrangler.jsonc`, 30
     a minute, counted per Cloudflare location), since any client can mint device ids and each is an object; where the
     binding isn't bound, as in tests, nothing is bounded.
2. **The Worker hands the watch to the device's Durable Object.** There's one SQLite-backed `Reminders` object per
   device (`worker/reminders.mts`).
   - It keeps the subscription, a SHA-256 of the device's secret, and each watch with its state.
   - Its one alarm is always the soonest check. The first is at once.
3. **Each check forecasts the run from what the Worker already has,** and costs nothing visible.
   - It reads the last 10 minutes of `samples` from D1: every bus fix, and the latest of Umo's predictions, which say
     which bus runs which trip and which runs aren't coming.
   - It follows every route's buses through the location model and pace (`sightingsFrom` over the `fleet` in
     `src/transit/models/tracking.mts`), by the one rule the map follows live and the nightly scoring replays.
   - It builds the day's runs once a check from the whole timetable with `buildRuns`, the map's forecasting, from the
     timetable and model the site serves (read from the map page's head, the build's manifest, once an hour, and a
     minute after a read that failed, keeping the last read meanwhile), so a bus going on from another route is
     followed onto the watched run, then looks each watched run up (`seenOf`): its departure from the stop, its band
     (`slack`), and whether a bus is on it. A run the forecast hasn't is `cancelled` if the timetable alone still has
     it, as the source then dropped it, and `lost` if it doesn't, as a timetable swapped since the watch was set.
   - Without the site's timetable or model, the run is due as scheduled, give or take (`scheduledOnly`), so the phone
     is still woken. A watch on no run is its fixed time exactly, with no band, and reads neither the site nor the
     samples.
   - `src/reminders/watch.mts` decides, purely: when to check again (halving the wait until the bus could leave,
     band allowed, within the lead, then a minute at a time; a watch on no run goes straight to its wake), and what
     to push (`check`): `due` once it could; after that, `update` if the time to be at the stop by, band allowed,
     moves 2 minutes earlier, or the bus itself 2 minutes later, or it's cancelled or lost, a band narrowing as the
     bus nears being no news; or `over`, once, if the run is gone, or past once its scheduled time has gone too,
     before it was ever near. A forecast that has the bus past the stop before its scheduled time is no news and the
     watch checks on, as a followed bus can be placed ahead of itself ([transit.md](transit.md), the Gables loop),
     which would otherwise push "may not be coming" for a bus still to come. So a bus that genuinely leaves early is
     reported, as missing, only once `at + GONE` has gone too, where the phone used to hear at once. A watch pushes
     at most 3 times, and one on no run once.
   - A watch set again under its id on the same run (`replaced`), as the map plans a kept trip afresh and its lead
     moves, goes on as the phone was told, its pushes counted, so the phone isn't woken twice for one bus; on another
     run or time it starts afresh.
   - A push made is saved on the watch as owed before it's sent, and alarms run at least once, so an object evicted
     between the two sends it when it next runs, and none is made twice. The alarm (`worker/reminders.mts`) delivers
     what's owed, then evaluates the due watches, then settles: `deliver`, `evaluate`, and the handler in that order.
4. **Pushes are Web Push from WebCrypto alone** (`worker/push.mts`): RFC 8291 encryption (aes128gcm, RFC 8188), RFC
   8292 VAPID, and RFC 8030's headers.
   - Each push carries its shape's version (`v`), and what the forecast says of the run (`Seen` in `watch.mts`): when
     its bus leaves the stop, how early to be there, whether a bus is on it, and whether it's still coming, cancelled,
     lost, or past, and when the check was. It sends `TTL` until the bus is gone, `Urgency: high`, and `Topic` set to
     the reminder, so a newer push replaces an undelivered one.
   - On 404 or 410, the device is forgotten, unless the phone has subscribed anew at another endpoint meanwhile, in
     which case the old push's answer says nothing about the new subscription. On 429 or 5xx, the push stays owed and
     is tried again after `Retry-After` if the service gives one, else after 30 s doubled each try, and given up
     after 5 tries or once the run is 2 h past its time, so a service that's down can't be asked forever.
5. **The service worker always shows a notification** (`src/sw/push.mts`), as iOS requires.
   - It words the notification from the push and the reminder it keeps (`meaningOf` and `textOf`), tersely: when to
     leave, which is the bus's time less the walk and the band, or the leave time itself; the first bus at its stop
     and how late it runs; the walk; and where the trip ends up and when, shifted by the first bus's delay, while
     that delay is within the margin, with the time asked to be there by if one was ("MUB 9:44, before your 9:50").
     Past the margin it says to open notunh instead: "may miss the 9:31 change" or "may be late for 9:50". A walk
     alone reads "14 min walk to MUB, there 9:40". A run cancelled or past, or gone before it was near, says the bus
     may not be coming; one lost says notunh lost track of the trip, as the timetable changed.
   - A push of a shape it doesn't know (another `v`) shows a plain "Time to head out". Pushes can arrive out of order,
     so the last shown is kept on the reminder, and a push older than it (by `at`) shows the last again.
   - It closes the reminder's earlier notification first, since Safari ignores `tag`.
   - Tapping the notification brings up an open map as it is, or opens `/map/?reminder=<id>` when none is.
6. **The map plans each reminder still ahead again as it loads** (`replan` in `src/map/state/reminders.mts`, with
   the planner's `plansFor` in `src/map/state/trip.mts`): only one yet to be left for, by a time yet to come, that no
   push has told the phone of (`isAhead`), as told, the trip is under way or past and a plan from here would be for
   another trip; from where you are if the trip was from there, by its way if that's still offered, else the best way
   now, or walking so as to be there by its time; and where the leave time has moved by 2 minutes (`SHIFT`) or the
   first bus has changed, keeps the fresh plan under the same id and `PUT`s it again, which the Worker takes as a
   replace. It waits for where you are to have been looked for (`located`) and for the live buses and their
   predictions to have been heard from, or to have failed (`heard`), up to 20 s, else not this time, so the plan is
   from where you are and as live as the one kept, rather than a timetable-only plan that moves the leave time and
   is `PUT` for nothing. A replan the Worker refuses keeps the plan it still watches; one it can't take now is kept as
   `setting` and told again later. A walk for now stays as it was. `/map/?reminder=<id>` brings the reminder's trip
   back first, from where you are if it was, and drops the link from the URL as `?to=` does.

## Every trip shape

| Trip | The watch | The push |
|---|---|---|
| Walked the whole way | `{ at: start, lead: headsUp }` | Once, at `at - lead`: "Leave in 5 min · 14 min walk to X, there 9:40" |
| A walk and a bus | `{ at: scheduled, lead: walk + headsUp (+ 1 min while no bus is out), run }` | When the bus could leave within the lead, its band allowed; again if it moves |
| A long walk then a bus | The same, the lead capped at 60 min | The same |
| Buses with a change | The first bus's, as above; the margin is the least change's slack | The arrival shifts with the first bus's delay while it's within the margin; past it, "may miss the 9:31 change · open notunh" |
| Arrive by T | As the shape above, planned to leave latest and get there by T (`planBy`); the margin includes `T - end` | "there 9:44, before your 9:50", or past the margin "may be late for 9:50 · open notunh" |

## Why this shape

- **iOS and iPadOS (16.4+)** push only to Home Screen web apps, ask permission only straight from a tap, and revoke
  permission from a site whose push shows nothing (https://webkit.org/blog/13878/, https://webkit.org/blog/12945/,
  https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers).
  - They ignore `tag`, `renotify`, `silent` and `actions` (https://bugs.webkit.org/show_bug.cgi?id=258922, MDN's
    compatibility data).
  - So notifications stack, and every push alerts.

  That's why the checking happens in the Worker, where checks are free, and why the Worker forecasts with the model
  rather than relaying Umo: the final "leave" has to be right from the server alone, and held out the model's median
  error is half Umo's at every lead ([transit.md](transit.md)).
- **Durable Object alarms** are on the free plan: SQLite-backed objects only, 100,000 requests and 100,000 rows written
  a day (https://developers.cloudflare.com/durable-objects/platform/pricing/,
  https://developers.cloudflare.com/durable-objects/api/alarms/), and 30 s of CPU per invocation
  (https://developers.cloudflare.com/durable-objects/platform/limits/), where a plain request gets 10 ms. A watch is
  some tens of checks, each a request, a row written, and 10 or so `samples` rows read, so the plan covers a couple of
  thousand reminders a day.
  - A check's work, measured in Node on an archived weekday (Oct 15, every 20 minutes from 8 to 20 h): decoding the
    12 rows of samples 1 to 6 ms, following the route's buses 2 to 6 ms, forecasting the run on the route's trips under
    1 ms, and a few ms once per instance to parse the timetable and model. Production has run 4 to 5 times slower than
    Node, so expect 20 to 50 ms a check. Confirm after a deploy with `wrangler tail --format pretty`, whose alarm
    events report `cpuTime`.
  - Alarms run at least once, so a push is saved as made before it's sent.
  - Other requests of the object arrive while it awaits the samples or the push service, so a check stamps each watch
    as it found it and leaves alone one replaced or cancelled meanwhile.
  - The account's five cron triggers are four used, and give one minute at best.
- **No library sends the pushes.** The one maintained, correct WebCrypto library, `@block65/webcrypto-web-push`, is
  about as long as `worker/push.mts`, which is checked against RFC 8291's own example in tests.
  `@pushforge/builder` and `webpush-webcrypto` send the obsolete `aesgcm` coding.
- **Plain pushes, not Declarative Web Push.** Safari 18.4's declarative messages hand a `mutable` message to a
  `pushnotification` event, not `push`, which would skip the phone's wording for a generic one. Every push here is JSON
  for the service worker's `push` handler, which iOS 16.4 on supports.

## What the Worker keeps

| What | Where | Kept |
|---|---|---|
| Push endpoint and keys, SHA-256 of the device secret, last use | The device's `Reminders` object, `device` table | 30 days after the last check, or until the push service says the subscription's gone, or `DELETE /api/push/devices/:device` |
| Each watch: a time, a lead, the run if there is one (trip, stop, route), pushes made, and what it last told the phone | `reminders` table | Until the bus has gone by, or it's cancelled; a row from before watches had a time is dropped when the object next runs |

The home page's `#reminders` details say this in plain words. Nothing about reminders reaches PostHog except a
`reminder_set` event, for those who opted in, sent unlinked like `trip_planned` (`UNLINKED` in `src/shell/events.mts`):
a fresh id, the hour, and nothing else.

Once pushes can no longer reach the phone (notifications turned off, or the subscription gone), the next trip planned
tells the Worker to forget the device (`DELETE /api/push/devices/:device`), and the phone drops its reminders and the
device's id and secret, making new ones for its next reminder. The object's tables are made on a device's first
reminder and dropped when it's forgotten, so asking an unknown device anything but to set one leaves nothing behind.

## Routes

All of these are public. Each device's reminders go by its secret, sent as a bearer token. `PUT` is limited to 30 a
minute from one address through the Rate Limiting binding
(https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), besides the ten reminders a device may
hold.

| Route | |
|---|---|
| `GET /api/push/key` | The VAPID public key, or 404 where reminders aren't set up, as in Previews |
| `PUT /api/reminders/:id` `{ device, subscription, watch }` with `Authorization: Bearer <secret>` | Sets a watch, 204. 401 without the secret, 403 for another device's, 409 past 10 at once, 429 past the address's limit, 400 for an endpoint that isn't a push service's (Apple, Google, Mozilla, Microsoft), a time already gone or more than 36 h ahead, a run without its stop, route and trip, or a lead outside 1 to 60 minutes |
| `DELETE /api/reminders/:id?device=` with `Authorization: Bearer <secret>` | Cancels one |
| `DELETE /api/push/devices/:device` with the same | Forgets the device |

## Setting it up

The Worker needs a VAPID key pair as secrets. Without one, reminders aren't offered.

- **For notunh.app:** `node scripts/secrets.mts vapid` makes the Worker's pair, set through `wrangler secret bulk`
  and never shown, and a separate pair for `.dev.vars`, each only where missing ([deploying.md](deploying.md)).
  `node scripts/secrets.mts check` says whether both are there.
  - The Worker's pair is never replaced: a new one orphans every subscription.
  - `VAPID_SUBJECT` is a var in `wrangler.jsonc` (`https://notunh.app`).
- **The deploy applies the Durable Object migration.** `migrations` in `wrangler.jsonc` has tag `reminders-1`, with
  `new_sqlite_classes`. While it's pending, this branch's own Preview build may fail on it, until main has deployed
  it.

## Testing it

- **Unit and property tests** (`npm test`):
  - `tests/reminders/`:
    - the lead heuristic's bounds and monotonicity; a reminder's leave time is the itinerary's own start for every
      shape; the wake is never later than the heads-up before leaving, however the heads-up is chosen, and never
      later for a longer walk; the case of a bus in 10 min with an 8 min walk; what's too soon; the margin;
    - the watch under random drifts, bands, checks that couldn't be made, and a run cancelled or lost: it always ends,
      pushes at most 3 times, says `due` before anything else or `over` alone, wakes the lead before the bus could
      leave to within a check, updates for a move of the time less the band and not for a band narrowing, and tries
      a push the service couldn't take with a doubling wait, a few times; a watch on no run pushes exactly once;
    - the forecast on half an hour of real samples (`tests/map/fixtures/buses.json.gz`): a route 3 bus followed to its
      stop, found by its trip or by its time under a renamed one, a run the source dropped as against one the timetable
      lost, a run on another route the bus goes on to foretold from the bus, and the timetable fallback;
    - what a push means for a reminder and its wording: never empty, the destination never in what the Worker sends;
    - the store (`store.test.mts`) over Cache Storage and Web Locks in memory: two tabs asking for the device at once
      get one, random batches of concurrent keeps and forgets end as a reference map does, a transition only moves a
      reminder still in the state it names, and a read that fails writes nothing;
    - the page's reminders (`client.test.mts`), each tab the module loaded afresh over one storage: two tabs' first
      reminders share a device, a reminder the Worker took but the phone couldn't keep as set is set again with the
      same id, one refused is dropped, one the address was limited for is kept as setting, one cancelled offline is
      kept as cancelling, worded so by a push meanwhile, and cancelled once back online, a replan replaces the watch
      under the same id only for a leave time moved by `SHIFT` or another first bus, only for a trip still ahead and
      untold, and a refused replan keeps the plan the Worker still has.
  - `tests/worker/push.test.mts`: RFC 8291's example byte for byte, a browser-side decryption of random messages, the
    VAPID JWT verified with the public key, and status handling.
  - `tests/worker/reminders.test.mts`: the routes and the Durable Object, with a fake object state on Node's SQLite
    (`tests/worker/durable.mts`), the same half hour of samples in a fake D1, the site's files served from memory, and
    the push service stubbed. Pushes are decrypted as the phone would, a watch replaced or cancelled while the
    samples are read is left alone, a subscription replaced while an old push comes back 410 is kept, an object
    restarted between making a push and sending it sends it once, the site is read again soon after a failed read
    and kept through a later one, a service that never takes a push is given up on, a forgotten device can set a
    reminder again, the address limit answers 429, the samples query is checked to go by the table's key, a watch on
    no run is pushed at its time less its lead with nothing read, and a row of the old watch shape is dropped.
  - `tests/shell/push.test.mts`: the service worker's handlers. Every push shows exactly one notification, whatever it
    carries or the phone keeps, a push of an unknown shape shows a plain one, and an older push shows the last again.
  - `tests/layers.test.mts`: `src/reminders/` imports only the domain beneath it and names no browser or storage
    global; `src/reminders/browser/` keeps and sends, and only the map's state is reactive.
- **Browser** (`npm run test:browser`): `tests/browser/push.browser.mts`, Chromium only.
  - It plans a ride the built site's own timetable offers, real or the fixtures', leaving now and to be there by a
    time, and walking the whole way, sets a reminder on each, and checks what the stubbed Worker is told against what
    Cache Storage keeps; saves the arrive-by trip as a goal and opens it again from the chip.
  - It opens `/map/?reminder=<id>` a couple of minutes on, as a tap would, which plans the trip again once the live
    buses have been asked for and finds the same bus, so the Worker isn't told again; then delivers a push straight to
    the service worker with DevTools' `ServiceWorker.deliverPushMessage` and checks the notification shown; and opens
    the map two hours on, when the trip is past and told of, which leaves the reminder as it was.
  - The subscription and the notification permission are stubbed, since headless Chromium has no push service and
    denies notifications whatever's granted. Notifications are recorded as shown, since it lists none.
- **Locally with wrangler:**
  1. `node scripts/secrets.mts vapid` once, which gives `.dev.vars` its own throwaway pair; `.dev.vars` is gitignored.
  2. `npm run build`, then `npx wrangler dev --local` serves the site and the API on http://localhost:8787 with the
     Durable Object. Its state lives under `.wrangler/`. The local D1 has samples only if the crons have run
     (`--test-scheduled`); without any, a check falls back on the timetable.
  3. `curl localhost:8787/api/push/key`, and `PUT`/`DELETE` reminders as in `tests/worker/reminders.test.mts`.
  4. A due alarm posts to the subscription's real push service. To watch the whole loop, set a reminder from Chrome on
     http://localhost:8787 (localhost counts as secure) for a bus a few minutes out.
- **Real devices:**
  - **iPhone:** reminders need the app on the Home Screen from an https origin. Previews have no secrets, so that
    means notunh.app with the secrets set, or a tunnel to `wrangler dev` with `.dev.vars`. Things to check: the
    permission prompt from the tap; one banner per push, and whether closing the earlier one works; Focus; airplane
    mode at the wake.
  - **Android Chrome:** `tag` replacement.

## Open questions

- **The service worker doesn't replan.** It rewords the stored itinerary with the first bus's time now; the map does
  the replanning when it next opens. A bus that may not be coming says to open notunh for another way.
- **Later buses of a trip with a change aren't watched.** The watch is the first bus's; the margin says whether the
  change still holds at the first bus's delay, and past it the push says to open notunh.
- **Rolling back** to before this storage: the IndexedDB `notunh-reminders` database isn't read any more and is left
  behind until the browser clears it; reminders set under it are forgotten on the phone, and the Worker ends their
  watches as their buses go by. The entry's `version` is bumped with any change of meaning, and another version reads
  as nothing kept but the device, whose id and secret the Worker's object still goes by, so its old watches run out
  under it and it's forgotten with them, rather than a second object being minted. A reminder set under version 1
  (the first bus alone) is forgotten on the phone at this deploy, and its push, if its bus hasn't gone, reads "Time to
  head out · Open notunh for your trip".
- **Previews have no Durable Object binding or secrets,** so reminders are off there, and `/api/push/key` 404s.
  Whether wrangler's `previews` block takes `durable_objects` is unverified.

Not verified on a device: whether `close()` works on current iOS; push delivery latency and alarm precision; a
check's CPU in production, as against Node; how a push service counts a message's size, taken here as 4 KB of body.
