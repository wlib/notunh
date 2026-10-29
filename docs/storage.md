# Storage

Every artifact and table: who makes it, its version, where it lives, how long it's kept. The code named is the source of truth. How the steps run is in [deploying.md](deploying.md); browser caching in [offline.md](offline.md).

A build only installs (`scripts/inputs.mts`) and writes nothing outside its folder. Only learning with `--store` writes D1's models: `inputs.yml` on `main` after the tests pass, or a run by hand. Devices write the social tables and `state` through the Worker, each as itself.

## Artifacts

"acquire" and "learn" are the nightly Inputs stages; "Bundled" files are named in a page's head and kept with it.

| Artifact | Made by | Version | Lives | Kept |
|---|---|---|---|---|
| Inputs: `src/map/gtfs.json`/`.zip`, `src/map/style.json` and its folder, `src/map/events.json`, `src/map/rooms.json`, `src/courses/courses.json`, `src/parking/parking.json`, `src/programs/prereqs.json`, `src/dining/menus.json`, `src/laundry/rooms.json`, `src/map/model.json`, `src/laundry/usual.json`, and their files | Inputs | `<Durham day>-<hash8>` of every file (`stageInputs` in `scripts/inputs.mts`) | Release `inputs-<version>`; pointer `latest.json` on release `inputs` | Forever (a few MB a night) |
| Map data: `walk.json`, `gazetteer.json`, `parking.json`, `tiles/<version>/` | `map.yml`, Mondays | `<extract date>-<generator8>` ([map.md](map.md)) | Release `map-data-<version>`; pointer on release `map-data` | Forever; the origin keeps served tiles one more build |
| `src/map/gtfs.json` | acquire | `feed.version` from GTFS `feed_info` | Bundled | With its page |
| `src/map/events.json` | acquire (`scripts/map/events.mts`): one request to each calendar ([social.md](social.md#official-events)); no person named | `fetched` | Bundled | With its page; missing reads as no events |
| `src/map/rooms.json` | acquire (`scripts/map/rooms.mts`): 25Live's spaces, then a request a day for the week's bookings of those placed, and Campus Rec's facilities and a request each for their week ([courses.md](courses.md#rooms-to-book)); never who booked, and no title that may name a person | `fetched`; each day's own | Bundled | With its page; missing reads as no rooms to book |
| `src/courses/courses.json` | acquire (`scripts/map/courses.mts`): 25Live's all-day entries, about ten requests, and each term's entry | `built`; each term's `fetched` is the registrar's `timestamp` on its oldest page | Bundled | With its page; missing reads as no terms |
| `public/data/courses/<hash>.json` | acquire: each live term's sections, and the next's once published, 100 a request, one at a time; addresses hidden (`src/courses/email.mts`) | Content hash | Static; a live term's loaded when a page wants courses, the next's only by a course's page | Tonight's, and the served index's one more build (`keepPublished` in `scripts/inputs.mts`) |
| `src/programs/prereqs.json`, `public/data/programs/<hash>.json` | acquire (`scripts/programs/prereqs.mts`): the catalog weekly, a page a second | `fetched`, `year`; files by content hash | Bundled index; the program list (about 24 KB gzipped) and each program (1 to 3 KB) loaded only when a page wants them | As courses' files; missing reads as none |
| `src/parking/parking.json` | acquire (`scripts/map/parking.mts`): the hand-kept areas checked against the zone table, ParkMobile and OSM, a request each | `built`; each source's time in `sources`, the oldest shown as "checked" | Bundled, loaded once parking is asked for | With its page; missing says parking couldn't load |
| `src/map/parking.json` | Map data: OSM's parking areas with tags, middle and outline | The extract's time | Map data; read only by parking's check | With its generation; without it the check reads the extract |
| `feeds` | learn, when the timetable differs from the last | `id` (SHA-256 of the JSON), `source` (of the zip), `acquired`, `version`/`start`/`end` as the feed says or `""` | D1 | Forever, to replay the days it was in effect (`inEffect` in `scripts/map/replay.mts`) |
| `src/map/model.json` | learn | `through`, shape `version` (4), `predictor` | Bundled | With its page; another version reads as an empty model |
| `models` (`buses`, `laundry`) | learn `--store` | `(name, through)`, `revision` per write; the last written is the latest | D1 | Last 30 per name (`saveModel`) |
| `derived` (`visits`, `statistics`, `evaluation`) and their `chunks` | learn, per service day | Manifest `identity` (observations id, timetable id, `EXTRACTOR`, plus model `version` or `PREDICTOR` and model hash) and `generation` (`worker/derived.mts`) | D1 | Visits `RETAIN_VISIT_DAYS` (180), others `RETAIN_STATISTICS_DAYS` (400) |
| `samples` | Worker crons: a row a minute (buses), every 5 (predictions) | `(source, minute)`; body `RAW_VERSION` (`raw.mts`), older versions still read | D1 | `RETAIN_ARCHIVED_DAYS` (14) once the catalog lists the day, never before |
| `observations-<day>.ndjson.zst` + `manifest.json` | `archive.yml` (`scripts/archive.mts`) | Service day; lossless, zstd -19 --long; manifest has SHA-256, bytes, counts | Release `observations-<day>`; `catalog.json` on release `observations` | Forever (~0.5 MB a weekday) |
| `transitions`, `polls` | Laundry cron | `at` | D1 | `RETAIN_DAYS` (60) |
| `latest`, `room_snapshots` | Laundry cron | Current only | D1 | While the room and machine are listed |
| `src/laundry/rooms.json` | acquire | Hashed | Bundled into pages and Worker | Until the next deploy |
| `src/laundry/usual.json` | learn | `through` | Bundled | With its page |
| `src/dining/menus.json` | acquire | `fetched` | Bundled | With its page |
| `public/data/dining/<hash>.json` | acquire; `keepPublishedMenus` | Content hash | Static | Tonight's, the served index's one more build, and any index's until 48 h past its last fetch (`carried` in `scripts/dining/publish.mts`, record at `/data/dining/published.json`) |
| `public/data/map/<hash>/` (style, sprite, glyphs) | acquire | Hash of its contents | Static | New and previously served folder |
| `src/map/tiles.json`, `src/map/places.json` | The build | `{ version, folders }`; hash of places' inputs | Bundled | With its page |
| `public/inputs.json` | The build | Inputs and map data versions | Static | With the deploy |
| Page HTML, `/sw.js` | `vite build` | `<meta name="release">` and the hashed files it names; the worker by its bytes | Static; SW cache | Current and previous per page in browsers |
| Reminders: the device's push subscription and secret's hash, and each watch (a time, a lead, the run if any, what the phone was last told) | `PUT /api/reminders/:id` | `reminders-1` migration; a row from before watches had a time is dropped | The device's `Reminders` Durable Object ([reminders.md](reminders.md)) | A watch until its time has gone; the device 30 days after its last, or until its push service says it's gone |
| Cache Storage `reminders-v1`, one JSON entry | Pages and the service worker, under one Web Lock | Entry `version` 3 (2 reads as 3; another reads as empty but for the device) | Browser | Each reminder whole until 2 h past its leave time or cancelled; the device's id and secret, which pins and marks are made as too |
| `devices` | A device's first social command ([social.md](social.md)) | `id` the device made; `secret`, the SHA-256 of its secret; `person`, its own id until linked; `push`, its last mark's subscription until gone | D1 | While any pin or address of its person is; never pruned yet |
| `pins` | `POST /api/pins`, under an id the device made | `(id)`; `times` to pick from; `chosen` once set; `spots` | D1 | Until 2 h after its end (`LINGER`), then pruned with its `going`, `marks` and `reports` |
| `going`, `marks`, `reports` | Each device's Going, mark, or report | `(pin, device[, time])`, one row each | D1 | With the pin |
| `links` | `POST /api/link` | `(code)`; `linked` once approved | D1 | 2 minutes (`LINK_TTL`), dropped by the next code or the prune |
| `emails` | `POST /api/email` | `(address)`, lower-cased; the verified holder and when; the attempt under way: who, the code's SHA-256, expiry, tries | D1 | Until the person asks to be forgotten; a verification counts a year |
| `state` | `POST /api/state` (`src/shell/sync.mts`) | `(person, key)`; `value` (JSON), `at` and `by`, the newer winning (`isNewer` in `src/shared/sync.mts`) | D1 | While the person is; moved, newer row kept, when a device is linked or recovered |
| `localStorage`, synced | Pages, as `state`'s cache | `courses-saved` (term:CRN), `map-goals` (saved trips: a place and a time to be there by), `parking-permit`, `laundry-favorites`, `dining-hall`, `dining-diets`, `dining-avoid` (`SYNCED`); `sync`, this browser's id, each key's stamp, and keys to send | Browser and D1 | Until cleared or Safari's seven-day rule; then taken back from `state` |
| `localStorage`, this device's | Pages | `map-trip` (today's trip), `map-riding` (the bus you're on), `map-chosen` (places chosen often in search), `usage` (your answer to usage stats) | Browser | Until cleared or Safari's seven-day rule |
| Cookie `notunh-device` | The Worker, on every command and `GET /api/session` (`worker/session.mts`) | The device's id and secret; `HttpOnly`, `SameSite=Lax`, `Path=/api/`, `Secure` over https | Browser | 400 days from the last command |

## Your things kept for you

The synced keys above live in D1 per person (the devices you've linked) and in each browser (`src/shared/sync.mts`, `src/shell/state.mts`, `src/shell/sync.mts`). Pages read and write the browser's copy, offline included. Each write is stamped with when and by which browser, and sent a second later; each load, return to the page, or return online sends what's pending and takes what's newer. The Worker keeps each key's newer write, clamping stamps to its own clock so a fast device clock can't win every later write, and devices take its answer but for keys written meanwhile. Values are JSON of at most 8 KB, and only `SYNCED` keys are taken. A browser with things from before sync sends them stamped 0, so anything newer elsewhere wins.

**When iOS clears storage.** In a Safari tab, everything script writes (`localStorage`, Cache Storage, IndexedDB) is deleted after seven days of use without a visit, the device's id and secret included (https://webkit.org/tracking-prevention/). A server-set cookie isn't, so the Worker keeps the credential in `notunh-device`, renewed for 400 days (Chrome's maximum, and WebKit's stated limit). It's first-party, from notunh.app's own host and addresses, so Safari's seven-day cap on cookies from cloaked or third-party addresses doesn't apply. A browser without an id and secret asks `GET /api/session` for them, then takes its things back. `HttpOnly` buys durability, not secrecy: the page is handed the secret it already held. A Home Screen app (iOS 16.4+) has its own cookies and storage, exempt from the deletion, and is a device of its own until linked; it also calls `navigator.storage.persist()`.

**When everything's gone.** "Clear History and Website Data", deleting the Home Screen app, or a private window loses the cookie too. The device is then new, and gets your things back by linking or by verifying a UNH address one of your devices verified within the year ([social.md](social.md#identity)).

**Privacy.** Synced things are kept by the Worker under a random person id, readable by whoever holds a linked device's secret or a verified address's inbox: the courses you saved, as term:CRN, and your saved trips' places and times among them. Reminders never sync: the Worker never learns where a reminder's trip goes or what class it's for ([reminders.md](reminders.md)). Today's trip, the bus you're on, places chosen in search, and your usage answer stay on the device. Nothing of `state` reaches PostHog.

The nightly prune reads the catalog first and prunes no samples if it can't. The service worker never caches live data (Umo, `/api/*`). Laundry's room list is edge-cached 300 s and a room 30 s (`worker/laundry.mts`), `max-age=0` in browsers. 25Live's word on a day is edge-cached 600 s and on one room 30 s, with every title, under a key no request reaches; each answer is made from it for the asker and is `private` (`worker/rooms.mts`).

## D1 sizing

D1 caps a database at 500 MB. Measured over Oct 7 to 19:

- **Samples**: about 1 MB a weekday, a third of that on weekends. Two weeks covers a fortnight of failed builds; if archiving fails, samples grow, leaving over a year before the cap.
- **Archive**: a day is about 3.9 MB raw, 640 KB gzip, 490 KB zstd.
- **Statistics**: about 24 KB gzipped a day, ~10 MB over 400 days.
- **Visits**: about 150 KB gzipped a day in one part, ~27 MB over 180 days, two row writes a day, so a rebuild stays within D1's daily writes. They can always be derived again.

Measure with `npm run storage` (`GET /api/storage`). `/api/health`'s `buses.since` shows how far back samples go.

## Concurrency

- Inputs runs never overlap (the workflow's concurrency group). Models are still stored compare-and-swap on `revision`: a run that read an older model gets a 409, and the inputs carry what's stored.
- A day's derived data is a generation: parts first, then a manifest that commits once every part is stored and deletes the replaced generation in the same transaction. Readers get manifest and parts in one read, so an interrupted or concurrent run leaves the last committed generation whole.
- The nightly prune drops parts no manifest names, even a running publication's, whose commit then fails and retries the next night.
