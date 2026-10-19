# Storage policy

Every artifact and table notunh makes: who makes it, when, what version it is, what it may be mixed with, where it lives, how long, and how it goes. The code named in each row is the source of truth; this is the map of it.

## Pipeline

A build (Cloudflare Workers Builds, from `main`, nightly from the Worker's cron and on push) runs `npm run build`, whose `prebuild` is, in order (`package.json`, `scripts/data.mts`):

1. **fetch**, read-only ingest: `scripts/map/gtfs.mts`, `map/style.mts`, `dining/menus.mts`, `laundry/rooms.mts`, `map/osm.mts`, `map/places.mts`
2. `npm run typecheck`, `npm test`
3. **learn**, which writes D1 through the Worker's API: `scripts/map/model.mts`, `scripts/laundry/model.mts`. It never fails the build: without `BUILD_TOKEN` or the Worker the last file stays, or an empty model
4. `vite build`, then `npm run deploy`, whose `predeploy` applies D1 migrations

Pull requests (`check.yml`) build with `NOTUNH_OFFLINE=1`: fetch copies `tests/fixtures/data/` in, learn does nothing, and no pull request reaches the GTFS host, Nutrislice, the laundry vendor, or GitHub releases. The fixtures are remade from a real build's data by `npm run fixtures` (`tests/fixtures/make.mts`), and are the fallbacks for the walk and gazetteer while there's no map data release.

## Artifacts

| Artifact | Made by, when | Version identity | Mixes with | Lives | Kept | Removed by |
|---|---|---|---|---|---|---|
| `src/map/gtfs.json` | build fetch, every build, from the GTFS zip | `feed.version` (GTFS `feed_info`), hashed into the page's head by Vite | the page that names it only; the model and visits of its day | bundled as `/assets/gtfs-<hash>.json` | as long as a page naming it is retained (below) | the next build's page naming another; SW prune |
| `models` row `gtfs` | build learn (`scripts/map/model.mts` `prepare`), the first build to see a new `feed.version` | `through` = the Durham day first seen, state = the feed | replay and refits of days at or after `through` (`replay.mts` `feedFor`) | D1 `models` | the last 30 versions | `saveModel`'s keep |
| `src/map/model.json` | build learn, every build with `BUILD_TOKEN` | `through` (last day folded) and `version` (shape), hashed into the head | the page that names it; folds on from the D1 row | bundled | with its page | next build; SW prune |
| `models` rows `buses`, `laundry` | build learn | `(name, through)`; compare-and-swap on the latest `through` (`POST /api/models/:name { expect }`, 409 on a race) | nothing else reads them | D1 `models` | the last 30 nights per name | `saveModel`'s keep |
| `visits` | build learn, once per sampled service day (and again on `--rebuild`) | per row `(vehicle, arrive)`, in schedule seconds | the feed in force that day | D1 `visits` | `RETAIN_VISIT_DAYS` = 180 | nightly `prune`; a day is replaced whole with `clear` |
| `samples` | Worker crons, each minute (buses) and each 5 (predictions) | `(source, minute)` | nothing; extracted once into `visits` | D1 `samples` | `RETAIN_DAYS` = 60 | nightly `prune` |
| `transitions`, `polls` | Worker laundry cron, every 5 min (15 overnight) | `at` in epoch ms | the laundry model's days | D1 | `RETAIN_DAYS` = 60 | nightly `prune` |
| `latest`, `room_snapshots` | Worker laundry cron | per machine, per room; current only | the laundry pages' answers | D1 | while the room is in `rooms.json` and the machine in the room's snapshot | nightly `prune` |
| `src/laundry/rooms.json` | build fetch, every build | the vendor's list, hashed into the Worker and pages | the Worker's crons and routes (bundled into the Worker) | bundled | with the deploy | next deploy |
| `src/laundry/usual.json` | build learn | `through`, hashed | its page | bundled | with its page | next build; SW prune |
| `src/dining/menus.json` | build fetch, every build | `fetched` (epoch ms), hashed | exactly the files it names (`files`) | bundled | with its page | next build; SW prune |
| `public/data/dining/<hash>.json` | build fetch | content hash of the record | any index naming it | Workers static assets, mutable paths by name only in that a name is its content | tonight's, plus last night's not named tonight while that index is under 48 h old (`carriedFiles`), fetched back from the site | the build after next |
| `src/map/style.json` and `public/data/map/<hash>/` | build fetch, every build, from live Liberty | hash of the restyled style, sprite, and glyphs; the manifest names the folder | its page; the planet build pinned in it | bundled manifest; static folder | one folder per build on the origin; in browsers with the page (`folders`) | `style.mts` deletes other folders; SW prune |
| map data generation: `walk.json`, `gazetteer.json`, `tiles/<version>/`, `manifest.json` | GitHub Actions `map.yml`, Mondays and on dispatch, `scripts/map/osm.mts` | `version` = `<extract date>-<generator8>`, where generator is `sha256` of the generating code, `campus.yml`, and Planetiler's version (`release.mts`, `src/map/made.mts`); each file carries `made` | only within one generation: a build takes the archive whole or fails; hashes are checked before the swap | GitHub release `map-data-<version>` (immutable, one `map-data.tar.gz` + its manifest); pointer `latest.json` on release `map-data`, uploaded last | forever on GitHub (small); on the origin, the pointer's tiles and the tiles the site served before, one build | the next build's `osm.mts` |
| `src/map/tiles.json` | build fetch (`osm.mts`) | `{ version, folders }`, or `{}` while there's no release | its page; the folder it names | bundled | with its page | next build; SW prune |
| `src/map/places.json` | build fetch, from the gazetteer, rooms, and halls | hashed | its page | bundled | with its page | next build |
| pages' HTML | `vite build` | `<meta name="release">` (build time) + the hashed code and data it names | nothing: a page is a generation | Workers static assets; SW cache (current + previous per page) | 2 per page in browsers | SW `revalidate` |
| `/sw.js` | `vite build` from `src/sw/` | its bytes | — | browser registration | until replaced | the browser, on byte change |
| `localStorage` | browser pages | keys `laundry-favorites`, `map-riding`, `dining-hall`, and the map's remembered state (`src/shell/state.mts` `remembered`) | nothing | the browser | until Safari's seven-day rule or the user clears it | the user; Safari |
| memory | pages | reactive values from `latest(name)` | swapped whole across files of one page (`src/shell/build.mts`) | the tab | the tab's life | navigation |

Live data, Umo's and the laundry API's, is never stored by a browser: `/api/*` and other origins bypass the service worker. The laundry list is shared at Cloudflare's edge for 300 s and a room for 30 s (`worker/laundry.mts`), `max-age=0` in browsers.

## Browser caches and eviction

The service worker keeps one Cache Storage cache, and what it keeps is the **closure of every generation in use**: each cached page's current and previous copy, whatever open windows answer they run (a census over `MessageChannel`, a second to answer), and what each one's data asks for by the `Retain` shape (`src/shell/manifest.mts`): the dining index its `files`, the tiles and style manifests their `folders`. Nothing else. Pruning runs after a newer page is kept, on activation, and when the origin's quota is hit.

The eviction verdict (`notunh-eviction-2026-10-18.md`): **no LRU, LFU, or byte cap**. The universe a browser can store is bounded by construction, about 14 MB worst case against a 1 GiB floor quota, so a frequency policy would never act and would cost a write per hit. On `QuotaExceededError`, `store` never fails the response: it runs the ladder once per storm, prune, then all the tiles, then the style's fonts and sprites, and otherwise answers from the network uncached (`src/sw/worker.mts` `SURRENDERABLE`). Pages, what they name, and the style JSON are never surrendered.

The HTTP cache sits behind the worker: pages are fetched with `cache: "no-cache"`, so a page's HTML is always the edge's; hashed assets are immutable by name and may be served from the HTTP cache on a first fill.

### iOS and Safari

- **Seven-day rule**: Safari deletes all of a site's script-writable storage, the cache, the service worker, and `localStorage`, after seven days of Safari use without interacting with the site. A home-screen app is exempt. Pages then come from the network as on a first visit and are cached again; the remembered state is gone, which the pages treat as a first visit.
- **Quota**: iOS 16.4 (our floor) gives an origin about 1 GiB; Safari 17+ about 60 % of disk, and 15 % in other apps' web views. Exceeding the origin's quota throws `QuotaExceededError`, which the ladder handles; exceeding the overall quota evicts whole origins, least recently used first, which nothing here can prevent and the first visit handles.
- Old deployed tabs: a tab on last night's page may ask for files the origin no longer has. The dining children stay two nights and the tiles' folder one build for this; the style's old folder does not, so an old map tab's uncached glyph range or sprite 404s until it reloads (maplibre draws without them).

## Worker and D1

D1's free plan allows 500 MB per database and 5 M rows read a day. Sizes, as of the reviews' estimates: samples about 3 MB a day for 60 days (180 MB); visits about 7 k rows a day, about 120 B each with the `umo` column (5 sampled predictions), which at 365 days would approach 300 MB, so `RETAIN_VISIT_DAYS` is 180: with the model's 28-day half-life a day 180 days back weighs 1 % of today's, and only `--rebuild` reads further back. The `umo` column stays because `--rebuild` rescores Umo's forecasts from stored visits (`replay.mts` `score`), which is the one record of how Umo did on a day.

Measure rather than estimate: `npm run storage` (`GET /api/storage`, token-gated) answers `{ bytes, rows: { table: n } }`, `bytes` from D1's own `size_after`. Counting reads every row, so it's on demand only; `GET /api/health` stays cheap (two index lookups a table) and public.

Models are stored with compare-and-swap on the latest `through`: a build that reads model `M` and tries to store over a newer one gets a 409 and bundles the newer one instead (`scripts/learn.mts`), so two builds learning at once converge on one line of models rather than overwriting each other. Visits are replaced a day at a time with `clear`, each request transactional; a build cut off between the clear and its last page leaves a day short until the next build, which extracts it again from samples while they're kept.

## GitHub

The Map data workflow publishes a generation only when the pointer doesn't already name it (`osm.mts` compares versions before Planetiler runs), so the Monday schedule and the Worker's Monday dispatch (nightly cron, with `GITHUB_TOKEN`) can both fire without publishing twice. GitHub pauses the schedule after 60 days without a commit; the dispatch doesn't pause, but needs the secret. Without it, and without commits, map data stops refreshing after 60 days until `gh workflow run map.yml`.

Releases are never deleted by anything here. Each is a few MB; deleting old `map-data-<version>` releases by hand is safe once no build names them, which is after the next build.
