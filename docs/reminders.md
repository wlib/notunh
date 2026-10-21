# Reminders: when to leave, by Web Push

"Remind me when to leave" on a chosen itinerary sets up a push to the phone when it's time to go.

- **The phone plans:** the trip, the walk to the first stop, how long before the bus to be woken, and what the
  notification says.
- **The Worker watches a run:** it's told which bus the phone wants to catch, as its trip and scheduled time at the
  stop, the stop, and how many minutes ahead to wake the phone. It forecasts that run with the same model the map
  uses, from the bus fixes it already records, and wakes the phone with what it foretells.
- **The Worker never learns** where the trip goes or where it's coming from. The default lead is the walk plus five
  minutes, to the half minute, so it does say about how far the stop is; the home page says so.

## How it works

1. **The phone sets the reminder.** `src/map/ui/Remind.tsx` builds the reminder from the itinerary (`reminderOf` in
   `src/reminders/reminder.mts`, pure), and `src/map/state/reminders.mts` subscribes to pushes, keeps it, and `PUT`s
   the watch to the Worker (`src/reminders/browser/api.mts`, the one client of the routes).
   - The reminder is kept whole (`src/reminders/browser/store.mts`): the trip, its route and stop by id and by name,
     the bus's scheduled and expected times, the walk, the lead, where the trip goes and when it gets there, and where
     it stands with the Worker. It's one JSON entry in a Cache Storage cache of its own (`reminders-v1`), which pages
     and the service worker share and `localStorage` isn't, and which the app's worker leaves alone when it drops
     older caches. Every change is read, edited and written under one Web Lock (`navigator.locks`, Safari 15.4+), so
     two tabs setting their first reminder at once get one device id and secret. IndexedDB would do the same with
     transactions and a schema, for more code.
   - **The phone and the Worker are kept agreeing by keeping first and telling after.** A reminder is kept as
     `setting` before the Worker is asked, and as `set` once it answers 204; a cancel is kept as `cancelling` until the
     Worker answers. Whatever the Worker refuses (4xx) is dropped with the reason; whatever it couldn't be told
     (offline, 5xx) is asked again with the same reminder id when the map next loads or the phone comes back online,
     which the Worker takes as a replace. The service worker words a push for a `cancelling` reminder as cancelled.
   - The walk is the itinerary's first walk leg's own length, as the planner has it, without the wait at the stop.
   - The lead (`leadTime`) is how long before the bus could leave to be woken: the walk, a 5-minute heads-up, and a
     minute more while no bus is on the trip yet, as a whole half minute between 1 and 60 minutes. A lead chosen from
     the menu (5 to 30 minutes) replaces it. The slack the bus's time needs isn't in it: the Worker allows that from the
     forecast's band at the time. It's pure and property-tested.
   - The watch (`watchOf`) is the stop, the route, the trip's id, its scheduled departure from the stop in epoch
     seconds, and the lead. The trip and time name the run among the day's, and the route, stop and time find it again
     under a timetable that has since renamed its trips (`runOf` in `src/reminders/forecast.mts`).
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
     is still woken.
   - `src/reminders/watch.mts` decides, purely: when to check again (halving the wait until the bus could leave,
     band allowed, within the lead, then a minute at a time), and what to push (`check`): `due` once it could; after
     that, `update` if its time moves by 2 minutes or more or it's cancelled or lost; or `over`, once, if the run is
     gone or past before it was ever near. A watch pushes at most 3 times.
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
   - It words the notification from the push and the reminder it keeps (`meaningOf` and `textOf`): when to leave,
     which is the bus's time less the walk and the band, the stop, how late the bus runs, and when you'll get there.
     A run cancelled or past, or gone before it was near, says the bus may not be coming; one lost says notunh lost
     track of the bus, as the timetable changed.
   - A push of a shape it doesn't know (another `v`) shows a plain "Time to head out". Pushes can arrive out of order,
     so the last shown is kept on the reminder, and a push older than it (by `at`) shows the last again.
   - It closes the reminder's earlier notification first, since Safari ignores `tag`.
   - Tapping the notification brings up an open map as it is, or opens `/map/` when none is.

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
| Each watch: the run (trip and scheduled time at the stop), stop, route, lead, pushes made, and the time it last told the phone | `reminders` table | Until the bus has gone by, or it's cancelled |

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
| `PUT /api/reminders/:id` `{ device, subscription, watch }` with `Authorization: Bearer <secret>` | Sets a watch, 204. 401 without the secret, 403 for another device's, 429 past 10 at once or past the address's limit, 400 for an endpoint that isn't a push service's (Apple, Google, Mozilla, Microsoft), a run already gone or more than 36 h ahead, or a lead outside 1 to 60 minutes |
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
    - the lead heuristic's bounds and monotonicity;
    - the watch under random drifts, bands, checks that couldn't be made, and a run cancelled or lost: it always ends,
      pushes at most 3 times, says `due` before anything else or `over` alone, wakes the lead before the bus could
      leave to within a check, and tries a push the service couldn't take with a doubling wait, a few times;
    - the forecast on half an hour of real samples (`tests/map/fixtures/buses.json.gz`): a route 3 bus followed to its
      stop, found by its trip or by its time under a renamed one, a run the source dropped as against one the timetable
      lost, a run on another route the bus goes on to foretold from the bus, and the timetable fallback;
    - what a push means for a reminder and its wording: never empty, the destination never in what the Worker sends;
    - the store (`store.test.mts`) over Cache Storage and Web Locks in memory: two tabs asking for the device at once
      get one, and random batches of concurrent keeps and forgets end as a reference map does;
    - the page's reminders (`client.test.mts`), each tab the module loaded afresh over one storage: two tabs' first
      reminders share a device, a reminder the Worker took but the phone couldn't keep as set is set again with the
      same id, one refused is dropped, one cancelled offline is kept as cancelling, worded so by a push meanwhile, and
      cancelled once back online.
  - `tests/worker/push.test.mts`: RFC 8291's example byte for byte, a browser-side decryption of random messages, the
    VAPID JWT verified with the public key, and status handling.
  - `tests/worker/reminders.test.mts`: the routes and the Durable Object, with a fake object state on Node's SQLite
    (`tests/worker/durable.mts`), the same half hour of samples in a fake D1, the site's files served from memory, and
    the push service stubbed. Pushes are decrypted as the phone would, a watch replaced or cancelled while the
    samples are read is left alone, a subscription replaced while an old push comes back 410 is kept, an object
    restarted between making a push and sending it sends it once, the site is read again soon after a failed read
    and kept through a later one, a service that never takes a push is given up on, a forgotten device can set a
    reminder again, the address limit answers 429, and the samples query is checked to go by the table's key.
  - `tests/shell/push.test.mts`: the service worker's handlers. Every push shows exactly one notification, whatever it
    carries or the phone keeps, a push of an unknown shape shows a plain one, and an older push shows the last again.
  - `tests/layers.test.mts`: `src/reminders/` imports only the domain beneath it and names no browser or storage
    global; `src/reminders/browser/` keeps and sends, and only the map's state is reactive.
- **Browser** (`npm run test:browser`): `tests/browser/push.browser.mts`, Chromium only.
  - It plans a ride the built site's own timetable offers, real or the fixtures', sets a reminder, and checks what the
    stubbed Worker is told against what Cache Storage keeps.
  - It then delivers a push straight to the service worker with DevTools' `ServiceWorker.deliverPushMessage` and checks
    the notification shown.
  - The subscription is stubbed, since headless Chromium has no push service. Notifications are recorded as shown,
    since it lists none.
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

- **Arrive-by planning ("be there by T")** isn't built. A reminder takes an itinerary as planned, so its arrival is the
  "by". A `planBy` in `plan.mts` would latest-start over the scans `plan` already runs.
- **The service worker doesn't replan.** It rewords the stored itinerary with the bus's time now. A bus that may not
  be coming says to open notunh for another way.
- **Rolling back** to before this storage: the IndexedDB `notunh-reminders` database isn't read any more and is left
  behind until the browser clears it; reminders set under it are forgotten on the phone, and the Worker ends their
  watches as their buses go by. The entry's `version` is bumped with any change of meaning, and another version reads
  as nothing kept.
- **Previews have no Durable Object binding or secrets,** so reminders are off there, and `/api/push/key` 404s.
  Whether wrangler's `previews` block takes `durable_objects` is unverified.

Not verified on a device: whether `close()` works on current iOS; push delivery latency and alarm precision; a
check's CPU in production, as against Node; how a push service counts a message's size, taken here as 4 KB of body.
