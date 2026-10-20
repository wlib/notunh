# notunh

The better UNH app, at [notunh.app](https://notunh.app). A PWA built with Vite and [bruh](https://github.com/Technical-Source/bruh), served as static assets by a Cloudflare Worker, on the free plan.

| Page | Entry | What it does |
|---|---|---|
| `/` | `index.html.tsx` | What's here and where the data comes from |
| `/map/` | `map/index.html.tsx`, `src/map/` | Live Wildcat Transit buses on MapLibre, bus + walking directions |
| `/dining/` | `dining/index.html.tsx`, `src/dining/` | Dining hall menus, search by food or ingredient, diet and allergen filters |
| `/laundry/` | `laundry/index.html.tsx`, `src/laundry/` | Free washers and dryers per room, and when each room is usually busy; each room has its own address, like `/laundry/adams-tower/` |

Every `*.html.tsx` is a page (vite-plugin-bruh). The browser floor is Safari/iOS 16.4 (`browserslist` in `package.json`, checked by `tests/shell/compat.test.mts`).

Pages are **offline first**: everything opens from the service worker's cache, the network is checked behind it, new data is swapped in live without a reload, and new code reloads quietly while the page is out of view (never mid-bus-ride). See [docs/offline.md](docs/offline.md).

## Layout

```
src/shared/       Pure helpers for pages, Worker, and scripts: Durham time, the learned-model fold, hashing, JSON, slugs
src/geo/          Geometry: projections, lines measured in meters, boxes, map matching
src/places/       Gazetteer, place search, Photon, laundry and dining buildings
src/transit/      The GTFS timetable (feed.mts) and route shapes
  observations/   What was observed: the Worker's stored rows, the archive, Umo's API as a live source
  inference/      What's inferred from fixes: GPS likelihoods, matching to shapes, passages between fixes, the
                  location model that joins them, and the nightly visit extraction
  models/         The learned model, its fit, bus movement, tracking, and the forecast
src/routing/      Walking network, walks, and the trip planner
src/shell/        Shared page shell: <head>, theme, Intl, clock and visibility, polling, release manifests, data loading
src/sw/           The service worker, built to /sw.js
src/map/          The map page: state/ (made by createMapState, nothing started on import), render/ (MapLibre), ui/,
                  basemap/ (style and tiles)
src/dining/, src/laundry/   Those pages: state.mts, ui/, and their logic
worker/           The Cloudflare Worker (Hono, Drizzle on D1): API, crons, laundry proxy
scripts/          The build's data pipeline, model training and replay, archiving, map data generation
tests/            Vitest + fast-check, mirroring src/; tests/browser/ runs the service worker in Playwright
```

**Dependency rule.** Domain layers import only the layers beneath them:

```
shared ← geo ← places
shared ← geo ← transit ──────┐
shared ← transit/observations ┴─ ← transit/inference ← transit/models ← routing (also on places)
```

Observations as stored never depend on what's inferred from them. No domain imports bruh, MapLibre, or a page's state/render/UI, and neither do `worker/` or `scripts/`, so training and replay run on the domains alone. `tests/layers.test.mts` checks every import.

**Conventions.**
- Every boundary (upstream APIs, data files, the Worker's request bodies) is checked with a [Valibot](https://valibot.dev) schema, which is also where its type comes from. Upstream answers keep the items that fit, so a change upstream shows less rather than garbage.
- Positions are `[lon, lat]` or `{ lat, lon }`, boxes are `[west, south, east, north]`, distances are meters on cheap-ruler's projection (`src/geo/projection.mts`, the only place one is made).
- Instants are **epoch milliseconds** wherever they cross a boundary (Worker rows, API JSON, page state, all of laundry). Times compared with the timetable are **schedule seconds** from the service day's start (the planner, the bus model, D1 `visits`). The location model works in epoch seconds internally.
- A calendar day is a `Day`, `YYYY-MM-DD` in Durham, which sorts as text; weekdays count from Monday.
- Bytes flow as async iterables of `Uint8Array`; gzip wherever a page or the Worker reads it, zstd only for the observations archive, which only scripts read.

## Running

```sh
npm run dev           # http://localhost:5173, fetching data first if it's missing (never learns)
npm test              # vitest + fast-check
npm run test:browser  # the service worker in Chromium and WebKit (once: npx playwright install chromium webkit)
npm run typecheck
npm run worker        # the Worker on http://localhost:8787 with a local D1; fire a cron with
                      # curl "localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
npm run data          # refresh every data file from upstream, and the models (`-- fetch` or `-- learn` for one stage)
npm run fixtures      # remake tests/fixtures/data from the data fetched
npm run icons         # regenerate PNG icons from public/icon.svg
npm run osm:refresh   # take the latest map data release, and rematch places
npm run model -- --local --store   # fit the bus model against `npm run worker` (BUILD_TOKEN here and in .dev.vars)
npm run storage       # D1's size in bytes and rows per table (needs BUILD_TOKEN)
npm run db:generate   # a migration in worker/migrations/ for changes to worker/schema.mts
```

Environment:
- `NOTUNH_OFFLINE=1` asks nothing upstream: every data file is copied from `tests/fixtures/data/` and nothing is learned. Pull requests build this way.
- `NOTUNH_STORE=1` (or `--store`) lets a build that isn't `main`'s store what it learns. Without it only Cloudflare's build of `main` (`WORKERS_CI_BRANCH=main`) writes models; anything else reads them as stored.
- `BUILD_TOKEN` is the Worker's bearer token for its rows, models, and storage routes. The build needs only this, never D1 credentials.
- `MODEL_REBUILD=1` (or `--rebuild`) refits the models from the first stored day.

## Building and deploying

Cloudflare Workers Builds builds `main` on every push and nightly (the Worker's 4:17 AM cron POSTs the Deploy Hook). The build command is `npm run build`, the deploy command `npm run deploy`. Keep both steps in `package.json` so the dashboard never needs editing.

1. `prebuild` fetches data (timetable, style, menus, rooms, map data, places), runs the typecheck and tests, then learns the bus and laundry models through the Worker (`scripts/data.mts`). Learning never fails the build: without the token or the Worker the last model stays.
2. `vite build`.
3. `predeploy` applies D1 migrations (`npm run db:migrate`); a failed migration stops the deploy.
4. `wrangler deploy` ships the Worker and site together.

Learning always talks to the Worker deployed before this push, so a change to the model API must work against the previous Worker too. If upstream is down the build fails and the last deploy stays up.

**Rolling back.** Clients never step back to a release older than the one they have, so `wrangler rollback` only reaches new visitors. To go back for everyone, publish the old release again: rebuild its commit, or stamp a folder an old build wrote with `node scripts/republish.mts <folder>` and deploy it with `wrangler deploy --assets <folder>` (after `npm run db:migrate`; Worker versions don't roll D1 back).

### Workflows and secrets

| Workflow | When | Does | Needs |
|---|---|---|---|
| Check (`check.yml`) | Pull requests | Offline build with fixtures, unit and browser tests | Nothing (read-only token, no secrets) |
| Observations (`archive.yml`) | Nightly 9:30 UTC, Worker dispatch, or `-f from= -f to=` | Archives each settled service day's samples as release `observations-<day>` and updates `catalog.json` | `BUILD_TOKEN` |
| Map data (`map.yml`) | Mondays, Worker dispatch, or by hand | Builds walk network, gazetteer, and tiles from OSM as release `map-data-<version>` | `CLOUDFLARE_DEPLOY_HOOK` (optional, to rebuild after) |
| Refresh (`refresh.yml`) | By hand | POSTs the Deploy Hook | `CLOUDFLARE_DEPLOY_HOOK` |

Worker secrets (`wrangler secret put`): `DEPLOY_HOOK`, `BUILD_TOKEN` (also a Workers Builds variable and a repository secret; locally in `.dev.vars`), and optionally `GITHUB_TOKEN` with the `actions` scope. GitHub pauses scheduled workflows after 60 days without a commit, so the Worker's nightly run dispatches Observations every night and Map data on Mondays when it has `GITHUB_TOKEN`.

## Data sources

- **Buses**: the Umo IQ rider API (no key, open CORS), polled by browsers directly and archived by the Worker's crons.
- **Timetable**: Wildcat Transit's GTFS feed on National RTAP, converted at build time (no CORS). Umo's trip and stop ids match it.
- **OpenStreetMap**: Geofabrik's New Hampshire extract, made weekly into the walking network, gazetteer, and tiles.
- **Base map**: OpenFreeMap's Liberty style, restyled and partly self-hosted at build time.
- **Menus**: Nutrislice, fetched at build time and split into content-addressed files under `public/data/dining/`.
- **Laundry**: LaundryConnect (Speed Queen), through the Worker. The proxy forwards the asker's own User-Agent; the cron sends none and polls each room every 5 minutes (15 overnight). Nothing else asks the vendor.

## Further notes

- [docs/offline.md](docs/offline.md): the service worker, release manifests, live data swaps, retention, and iOS quirks
- [docs/transit.md](docs/transit.md): the location model, bus movement, the forecaster, the learned model, and trip planning
- [docs/map.md](docs/map.md): map data generation, tiles, the base map, walking, and place search
- [docs/worker.md](docs/worker.md): the Worker's API, crons, and the laundry collector and model
- [docs/storage.md](docs/storage.md): every artifact and table, its version, where it lives, and how long it's kept
