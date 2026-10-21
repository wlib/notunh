# Storage

Every artifact and table: who makes it, its version, where it lives, and how long it's kept. The code named is the source of truth. How the steps run is in [deploying.md](deploying.md); browser caching is in [offline.md](offline.md).

A build only installs (`scripts/inputs.mts`) and writes nothing outside its folder. Only learning with `--store` writes D1: `inputs.yml` on `main` after the tests pass, or a run by hand.

## Artifacts

| Artifact | Made by | Version | Lives | Kept |
|---|---|---|---|---|
| Inputs: `src/map/gtfs.json`/`.zip`, `src/map/style.json` and its folder, `src/dining/menus.json` and its files, `src/laundry/rooms.json`, `src/map/model.json`, `src/laundry/usual.json` | Inputs, nightly | `<Durham day>-<hash8>` of every file (`stageInputs` in `scripts/inputs.mts`) | Release `inputs-<version>`; pointer `latest.json` on release `inputs` | Forever (a few MB a night) |
| Map data: `walk.json`, `gazetteer.json`, `tiles/<version>/` | `map.yml`, Mondays | `<extract date>-<generator8>` ([map.md](map.md)) | Release `map-data-<version>`; pointer on release `map-data` | Forever; origin keeps the served tiles one more build |
| `src/map/gtfs.json` | acquire | `feed.version` from GTFS `feed_info` | Bundled | With its page |
| `feeds` | learn, when the timetable acquired differs from the last | `id` (SHA-256 of the JSON), `source` (of the zip), `acquired` (Worker time), `version`/`start`/`end` as the feed says or `""` | D1 | Forever, to replay the days it was in effect (`inEffect` in `scripts/map/replay.mts`) |
| `src/map/model.json` | learn | `through`, shape `version` (4), `predictor` | Bundled | With its page; a page given another version uses an empty model |
| `models` (`buses`, `laundry`) | learn `--store` | `(name, through)`, `revision` per write; the last written is the latest | D1 | Last 30 per name (`saveModel`) |
| `derived` (`visits`, `statistics`, `evaluation`) and their `chunks` | learn, per service day | Manifest `identity` (observations id, timetable id, `EXTRACTOR`, plus model `version` or `PREDICTOR` and model hash) and `generation` (`worker/derived.mts`) | D1 | Visits `RETAIN_VISIT_DAYS` (180), others `RETAIN_STATISTICS_DAYS` (400) |
| `samples` | Worker crons: a row per minute (buses), per 5 (predictions) | `(source, minute)`; body `RAW_VERSION` (`raw.mts`), older versions still read | D1 | `RETAIN_ARCHIVED_DAYS` (14) once the catalog lists the day; never pruned before |
| `observations-<day>.ndjson.zst` + `manifest.json` | `archive.yml` (`scripts/archive.mts`) | Service day; lossless rows, zstd -19 --long; manifest has SHA-256, bytes, counts | Release `observations-<day>`; `catalog.json` on release `observations` | Forever (~0.5 MB a weekday) |
| `transitions`, `polls` | Laundry cron | `at` in epoch ms | D1 | `RETAIN_DAYS` (60) |
| `latest`, `room_snapshots` | Laundry cron | Current only | D1 | While the room and machine are listed |
| `src/laundry/rooms.json` | acquire | Hashed | Bundled into pages and Worker | Until the next deploy |
| `src/laundry/usual.json` | learn | `through` | Bundled | With its page |
| `src/dining/menus.json` | acquire | `fetched` (epoch ms) | Bundled | With its page |
| `public/data/dining/<hash>.json` | acquire; `keepPublishedMenus` | Content hash | Static | Tonight's, the served index's for one more build, and any index's until 48 h past its last fetch (`carried` in `scripts/dining/publish.mts`, record at `/data/dining/published.json`) |
| `public/data/map/<hash>/` (style, sprite, glyphs) | acquire | Hash of its contents | Static | New and previously served folder |
| `src/map/tiles.json`, `src/map/places.json` | The build | `{ version, folders }`; hash of places' inputs | Bundled | With its page |
| `public/inputs.json` | The build | Inputs and map data versions | Static | With the deploy |
| Page HTML, `/sw.js` | `vite build` | `<meta name="release">` and the hashed files it names; the worker by its bytes | Static; SW cache | Current + previous per page in browsers |
| Reminders: a device's push subscription, a hash of its secret, and each reminder's watch: a run (its trip and scheduled time at the stop), the stop and route, a lead, and the time it was last told | `PUT /api/reminders/:id` | `reminders-1` migration | The device's `Reminders` Durable Object ([reminders.md](reminders.md)) | A reminder until its bus has gone; the device 30 days after its last, or until its push service says it's gone |
| Cache Storage `reminders-v1`, one JSON entry | Pages, and the service worker, under one Web Lock | `version` in the entry | Browser | Each reminder whole, the bus and where it goes included, with where it stands with the Worker, until its bus is 2 h past or it's cancelled; the device's id and secret |
| `localStorage` | Pages | `laundry-favorites`, `map-riding`, `dining-hall`, map state (`src/shell/state.mts`) | Browser | Until cleared, or Safari's seven-day rule |

The nightly prune reads the catalog first and prunes no samples if it can't. Live data (Umo, `/api/*`) is never cached by the service worker. Laundry's room list is edge-cached 300 s and a room 30 s (`worker/laundry.mts`), `max-age=0` in browsers.

## D1 sizing

D1 caps a database at 500 MB. Measured over Oct 7 to 19:

- **Samples**: about 1 MB a weekday, a third of that on weekends. Two weeks covers a fortnight of failed builds. If archiving fails, samples grow rather than drop, leaving over a year before the cap.
- **Archive**: a day is about 3.9 MB raw, 640 KB gzip, 490 KB zstd.
- **Statistics**: about 24 KB gzipped a day, ~10 MB over 400 days, enough to compare a week with the same week a year before.
- **Visits**: about 150 KB gzipped a day in one part, ~27 MB over 180 days. A day costs two row writes, so a rebuild stays within D1's daily writes. They can always be derived again.

Measure with `npm run storage` (`GET /api/storage`). `/api/health`'s `buses.since` shows how far back samples go.

## Concurrency

- Inputs runs never overlap (the workflow's concurrency group). Models are still stored compare-and-swap on the latest `revision`: a run that read an older model gets a 409, and the inputs carry what's stored instead.
- A day's derived data is a generation: parts first, then a manifest that commits once every part is stored and deletes the replaced generation in the same transaction. Readers get manifest and parts in one read, so an interrupted or concurrent run leaves the last committed generation whole.
- The nightly prune drops parts no manifest names, even a running publication's, whose commit then fails and retries the next night.
