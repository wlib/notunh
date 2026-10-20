# Storage

Every artifact and table notunh makes: who makes it, how it's versioned, what it may be mixed with, where it lives, and how long. The code named in each row is the source of truth; this is the map of it. Browser caching is in [offline.md](offline.md).

## The build pipeline

Cloudflare Workers Builds runs `npm run build` from `main` on every push and nightly. Its `prebuild` (`package.json`, `scripts/data.mts`):

1. **fetch**, read-only: `scripts/map/gtfs.mts`, `map/style.mts`, `dining/menus.mts`, `laundry/rooms.mts`, `map/osm.mts`, `map/places.mts`
2. `npm run typecheck`, `npm test`
3. **learn**, writing D1 through the Worker's API: `scripts/map/model.mts`, `scripts/laundry/model.mts`. Never fails the build: without `BUILD_TOKEN` or the Worker, the last file stays, or an empty model. Only `main`'s build (`WORKERS_CI_BRANCH`) or `--store`/`NOTUNH_STORE=1` stores what it learns (`isStoring` in `scripts/learn.mts`); any other build bundles the stored models as they are. So does a build reaching a Worker too old for the model API it expects, as the first build of a change to that API does, since it runs before its Worker deploys
4. `vite build`, then `npm run deploy`, whose `predeploy` applies D1 migrations

`npm run dev` runs fetch alone. Pull requests (`check.yml`) build with `NOTUNH_OFFLINE=1`: fetch copies `tests/fixtures/data/` in and learn does nothing, so no pull request reaches the GTFS host, Nutrislice, the laundry vendor, or GitHub releases. `npm run fixtures` (`tests/fixtures/make.mts`) remakes the fixtures from a real build's data; they're also the walk and gazetteer fallbacks while there's no map data release.

## Artifacts

| Artifact | Made by, when | Version | Mixes with | Lives | Kept | Removed by |
|---|---|---|---|---|---|---|
| `src/map/gtfs.json` | fetch, every build | `feed.version` (GTFS `feed_info`); hashed into the page head | any build's model, walk, and gazetteer, by stop/route ids and coordinates | bundled | with its page | next build; SW prune |
| `models` row `gtfs` | learn, first build to see a new `feed.version` | `through` = the Durham day first seen | replay and refits of days on or after `through` (`feedFor` in `replay.mts`) | D1 `models` | last 30 versions | `saveModel` |
| `src/map/model.json` | learn, every build with `BUILD_TOKEN` | `through` (last day folded), shape `version` (3) | any build's timetable, by stop and route ids; a page given another version uses an empty model | bundled | with its page | next build; SW prune |
| `models` rows `buses`, `laundry`, `*.training` | learn | `(name, through)`, `revision` renewed by every write, `written` order (the last written is the latest, whatever day it runs through) | nothing else | D1 `models` | last 30 per name | `saveModel` |
| `visits` | learn, once per sampled service day (again on `--rebuild`) | per row `(vehicle, arrive)` in schedule seconds; `extractor` (null = 1, zone crossings; 2 = location model; 3 = with fitted likelihoods), which alone fills `spread`, `dwelled`, `flags`, `profile` | the feed in force that day | D1 | `RETAIN_VISIT_DAYS` = 180 | nightly prune; a day is replaced whole with `clear` |
| `summaries` | learn, once per service day | `at` (service day start), model `version` and `extractor` | that day's visits | D1 | `RETAIN_SUMMARY_DAYS` = 400 | nightly prune; `clear` |
| `samples` | Worker crons: a row per minute polled (buses), per 5 (predictions), even if nothing was seen | `(source, minute)`; body names `RAW_VERSION` (`raw.mts`). Version 2 records each poll (when asked, live bus count or null on failure) and which poll first saw each fix; version 3 times each poll when it was answered or failed instead. Older versions still read | nothing; the source of truth every extraction reads | D1 | `RETAIN_ARCHIVED_DAYS` = 14 once the catalog lists the day, else `RETAIN_DAYS` = 60 | nightly prune, which reads the catalog first; if it can't, prunes only past 60 days |
| `observations-<day>.ndjson.zst` + `manifest.json` | `archive.yml`, nightly, or by hand for a range (`scripts/archive.mts`) | the service day; each line a stored row decoded (`{ source, at, version, samples, polls }`), lossless, zstd level 19 with long-distance matching. The manifest names the file (older days, without a name, are `.ndjson.gz`), with SHA-256, bytes, and per-source counts | read like D1 (`observationsOf` in `scripts/observations.mts`, hash-checked while streaming) | GitHub release `observations-<day>`, immutable once its manifest is up; `catalog.json` on release `observations`, uploaded last | forever (about 0.5 MB a weekday, 150 MB a year) | never |
| `transitions`, `polls` | Worker laundry cron | `at` in epoch ms | the laundry model's days | D1 | `RETAIN_DAYS` = 60 | nightly prune |
| `latest`, `room_snapshots` | Worker laundry cron | per machine / per room, current only | the laundry routes | D1 | while the room and machine are still listed | nightly prune |
| `src/laundry/rooms.json` | fetch, every build | the vendor's list, hashed | the Worker's crons and routes (bundled in) | bundled | with the deploy | next deploy |
| `src/laundry/usual.json` | learn | `through`, hashed | its page | bundled | with its page | next build; SW prune |
| `src/dining/menus.json` | fetch, every build | `fetched` (epoch ms), hashed | exactly the files it names (`files`) | bundled | with its page | next build; SW prune |
| `public/data/dining/<hash>.json` | fetch | content hash | any index naming it | static assets | tonight's; those the served index names, one more build; those published before until 48 h past the last index naming them (`carried` in `publish.mts`, record at `/data/dining/published.json`), fetched back from the site | the first build after that |
| `src/map/style.json`, `public/data/map/<hash>/` | fetch, every build, from live Liberty | hash of the restyled style, sprite, and glyphs; the manifest names the folder and requires its `style.json` | its page; the planet build pinned in it | bundled manifest; static folder | origin: new folder and the previously served one; browsers: with the page | `style.mts` deletes others; SW prune |
| map data: `walk.json`, `gazetteer.json`, `tiles/<version>/`, `manifest.json` | `map.yml`, Mondays and on dispatch | `<extract date>-<generator8>` ([map.md](map.md)); each file carries `made` | a build takes one generation whole or fails; in a page each file is its own slot, meeting others by coordinates | GitHub release `map-data-<version>` (immutable); pointer `latest.json` on release `map-data`, uploaded last | GitHub forever; origin: the pointer's tiles and the previously served ones, one build | next build's `osm.mts` |
| `src/map/tiles.json` | fetch (`osm.mts`) | `{ version, folders }`, or `{}` without a release | its page; the folder it names | bundled | with its page | next build; SW prune |
| `src/map/places.json` | fetch, from gazetteer, rooms, and halls | `inputs`, a hash of those and the deriving code; kept with `--if-missing` only while it matches | its page | bundled | with its page | next build |
| page HTML | `vite build` | `<meta name="release">` + the hashed files it names | nothing: a page is a generation | static assets; SW cache (current + previous per page) | 2 per page in browsers | SW |
| `/sw.js` | `vite build`, from `src/sw/` | its bytes | — | browser registration | until replaced | the browser, on byte change |
| `localStorage` | pages | `laundry-favorites`, `map-riding`, `dining-hall`, and the map's remembered state (`remembered` in `src/shell/state.mts`) | nothing | the browser | until Safari's seven-day rule or the user clears it | user; Safari |

Live data (Umo, the laundry API) is never stored by a browser: `/api/*` and other origins bypass the service worker. The laundry room list is shared at Cloudflare's edge for 300 s and a room for 30 s (`worker/laundry.mts`), `max-age=0` in browsers.

## D1 sizing

The free plan allows 500 MB per database and 5 M rows read a day. Measured on Oct 7 to 19:

- **Samples**: a weekday is about 30 k bus fixes in about 1,150 minute rows, 620 KB of gzipped bodies, plus about 280 KB of predictions; weekends about a third. So about 1 MB a weekday, 14 MB at two weeks, and at most about 60 MB at the 60-day cap if archiving fails. Two weeks covers a fortnight of failed builds or refits without GitHub, and twice the archive workflow's one-week look-back.
- **Archive**: the same day as one ndjson file is about 3.9 MB raw, 640 KB gzip -9, 490 KB zstd -19 --long. Only scripts read it, so it can be zstd; everything a page or the Worker reads stays gzip, which Workers and Safari 16.4's `DecompressionStream` support.
- **Summaries**: about 86 KB JSON (24 KB gzipped) a day, so 400 days is about 35 MB, long enough to compare a week with the same week a year before.
- **Visits**: about 7 k rows a day at about 120 B each, which would approach 300 MB a year, so they're kept 180 days. With the 28-day half-life, a day 180 days back weighs 1 % of today's; only `--rebuild` reads further. The `umo` column (Umo's prediction sampled at each scoring lead) stays because it's the only record of how Umo did on a day, which `--rebuild` rescores (`score` in `replay.mts`).

Measure rather than estimate: `npm run storage` (`GET /api/storage`, token-gated) gives `{ bytes, rows: { table: n } }`, with `bytes` from D1's own `size_after`.

**Concurrency.** Models are stored with compare-and-swap on the latest row's `revision`. A build that read model `M` and tries to store over anything written since gets a 409 and bundles the newer model instead, so two builds learning at once converge on one line of models. Visits and summaries are replaced a day at a time with `clear`, each request transactional; a build cut off mid-day leaves that day short until the next build extracts it again from samples.

## GitHub releases

- **Map data** publishes a generation only when the pointer doesn't already name it (`osm.mts` compares versions before Planetiler runs), so the schedule and the Worker's Monday dispatch can't double-publish.
- **Observations** publishes each settled service day not yet published, looking back a week, so a failed night is made up by the next; `gh workflow run archive.yml -f from=<day> -f to=<day>` backfills anything D1 still holds. A day's release is immutable once its `manifest.json` is up: a later run only merges that manifest into the catalog again, and a release left without one is filled in again from D1 (which still has the day, since the catalog never listed it). `catalog.json` is only merged into, never rebuilt, and uploaded last, so the Worker never prunes a day whose archive isn't whole. A catalog that can't be downloaded fails the run rather than being replaced.
- GitHub pauses schedules after 60 days without a commit. The Worker's nightly dispatch doesn't pause but needs `GITHUB_TOKEN`; without either, map data stops refreshing and samples are lost past their 60 days.

Nothing here deletes releases. Each is a few MB. Old `map-data-<version>` releases are safe to delete by hand once no build names them, which is after the next build.
