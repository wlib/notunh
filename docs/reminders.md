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

1. **The phone sets the reminder.** `src/map/ui/Remind.tsx` builds the reminder (`src/reminders/reminder.mts`),
   subscribes to pushes, and `PUT`s the watch to the Worker (`src/reminders/client.mts`).
   - The reminder is kept whole in IndexedDB (`src/reminders/store.mts`), which pages and the service worker share and
     `localStorage` isn't: the trip, its route and stop by id and by name, the bus's scheduled and expected times, the
     walk, the lead, and where the trip goes and when it gets there.
   - The walk is the itinerary's first walk leg's own length, as the planner has it, without the wait at the stop.
   - The lead (`leadTime`) is how long before the bus could leave to be woken: the walk, a 5-minute heads-up, and a
     minute more while no bus is on the trip yet, as a whole half minute between 1 and 60 minutes. A lead chosen from
     the menu (5 to 30 minutes) replaces it. The slack the bus's time needs isn't in it: the Worker allows that from the
     forecast's band at the time. It's pure and property-tested.
   - The watch (`watchOf`) is the stop, the route, the trip's id, its scheduled departure from the stop in epoch
     seconds, and the lead. The trip and time name the run among the day's, and the route, stop and time find it again
     under a timetable that has since renamed its trips (`runOf` in `src/reminders/forecast.mts`).
2. **The Worker hands the watch to the device's Durable Object.** There's one SQLite-backed `Reminders` object per
   device (`worker/reminders.mts`).
   - It keeps the subscription, a SHA-256 of the device's secret, and each watch with its state.
   - Its one alarm is always the soonest check. The first is at once.
3. **Each check forecasts the run from what the Worker already has,** and costs nothing visible.
   - It reads the last 10 minutes of `samples` from D1: every bus fix, and the latest of Umo's predictions, which say
     which bus runs which trip and which runs aren't coming.
   - It follows the route's buses through the location model and pace (`sightingsFrom` in
     `src/transit/models/tracking.mts`), as the map does live and the nightly scoring replays.
   - It builds the day's runs of that route alone with `buildRuns`, the map's forecasting, from the timetable and
     model the site serves (read from the map page's head once an hour), and reads the run's departure from the stop,
     its band (`slack`), and whether a bus is on it (`seenOf`).
   - Without the site's timetable or model, the run is due as scheduled, give or take (`scheduledOnly`), so the phone
     is still woken.
   - `src/reminders/watch.mts` decides, purely: when to check again (halving the wait until the bus could leave,
     band allowed, within the lead, then a minute at a time), and what to push (`check`): `due` once it could; after
     that, `update` if its time moves by 2 minutes or more or it's cancelled; or `over`, once, if the run is cancelled
     or past before it was ever near. A watch pushes at most 3 times.
4. **Pushes are Web Push from WebCrypto alone** (`worker/push.mts`): RFC 8291 encryption (aes128gcm, RFC 8188), RFC
   8292 VAPID, and RFC 8030's headers.
   - Each push carries what the forecast says of the run (`Seen` in `watch.mts`): when its bus leaves the stop, how
     early to be there, whether a bus is on it, and whether it's still coming, cancelled, or past. It sends `TTL`
     until the bus is gone, `Urgency: high`, and `Topic` set to the reminder, so a newer push replaces an undelivered
     one.
   - On 404 or 410, the device is forgotten. On 429 or 5xx, the push is tried again after `Retry-After` if the
     service gives one, else after 30 s doubled each try, and given up after 5 tries or once the run is 2 h past its
     time, so a service that's down can't be asked forever.
5. **The service worker always shows a notification** (`src/sw/push.mts`), as iOS requires.
   - It words the notification from the push and the reminder it keeps (`meaningOf` and `textOf`): when to leave,
     which is the bus's time less the walk and the band, the stop, how late the bus runs, and when you'll get there.
     A run cancelled or past, or gone before it was near, says the bus may not be coming.
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

All of these are public. Each device's reminders go by its secret, sent as a bearer token. The routes aren't rate
limited beyond the ten reminders a device may hold; a Rate Limiting binding on `PUT` is a follow-up.

| Route | |
|---|---|
| `GET /api/push/key` | The VAPID public key, or 404 where reminders aren't set up, as in Previews |
| `PUT /api/reminders/:id` `{ device, subscription, watch }` with `Authorization: Bearer <secret>` | Sets a watch, 204. 401 without the secret, 403 for another device's, 429 past 10 at once, 400 for an endpoint that isn't a push service's (Apple, Google, Mozilla, Microsoft), a run already gone or more than 36 h ahead, or a lead outside 1 to 60 minutes |
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
      stop, found by its trip or by its time under a renamed one, and the timetable fallback;
    - what a push means for a reminder and its wording: never empty, the destination never in what the Worker sends.
  - `tests/worker/push.test.mts`: RFC 8291's example byte for byte, a browser-side decryption of random messages, the
    VAPID JWT verified with the public key, and status handling.
  - `tests/worker/reminders.test.mts`: the routes and the Durable Object, with a fake object state on Node's SQLite
    (`tests/worker/durable.mts`), the same half hour of samples in a fake D1, the site's files served from memory, and
    the push service stubbed. Pushes are decrypted as the phone would, a watch replaced or cancelled while the
    samples are read is left alone, a service that never takes a push is given up on, a forgotten device can set a
    reminder again, and the samples query is checked to go by the table's key.
  - `tests/shell/push.test.mts`: the service worker's handlers. Every push shows exactly one notification, whatever it
    carries or the phone keeps.
- **Browser** (`npm run test:browser`): `tests/browser/push.browser.mts`, Chromium only.
  - It plans a trip, sets a reminder, and checks what the stubbed Worker is told against what IndexedDB keeps.
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
- **Previews have no Durable Object binding or secrets,** so reminders are off there, and `/api/push/key` 404s.
  Whether wrangler's `previews` block takes `durable_objects` is unverified.

Not verified on a device: whether `close()` works on current iOS; push delivery latency and alarm precision; a
check's CPU in production, as against Node; how a push service counts a message's size, taken here as 4 KB of body.
