# notunh

The better UNH app, at [notunh.app](https://notunh.app): a PWA built with Vite and [bruh](https://github.com/Technical-Source/bruh), served as static assets from Cloudflare Workers.

Each section is its own page and bundle, sharing a shell (`src/shell/`: the `<head>`, theme, icons, Intl formatting, the one clock and visibility every page follows, remembered state, polling, and the service worker):

- `/` (`index.html.tsx`): what's here, who made it, and where the data comes from
- `/map/` (`map/index.html.tsx`, `src/map/`): live Wildcat Transit buses and routes on MapLibre GL with the OpenFreeMap Liberty style, and bus + walking directions
- `/dining/` (`dining/index.html.tsx`, `src/dining/`): dining hall menus, with search by food or ingredient and diet and allergen filters
- `/laundry/` (`laundry/index.html.tsx`, `src/laundry/`): which washers and dryers are free in every laundry room, and when each room is usually busy, with each room at its own address, like `/laundry/adams-tower/`

Within a section, `state.mts` holds the reactive state and live data, `ui/` the components, and the rest the logic, with the pure parts property tested. Each npm package builds into its own chunk, so a change to the app leaves maplibre cached.

`src/shared/` is what the pages, the Worker, and the build all use, with neither the DOM nor Node: Durham's clock and calendar (`time.mts`), the fold every learned model shares (`learn.mts`), `getJson`, and the slugs links name places by. Time comes in two units, and only two:

- **Epoch milliseconds**, as `Date.now()` gives them, for every instant that crosses a boundary: Worker rows, API JSON, page state, and everything in laundry.
- **Schedule seconds** where times are compared with the GTFS timetable, which counts seconds from a service day's start: the planner, the bus model, and the visits it learns from, in the D1 `visits` table too.

A calendar day is a `Day`, `YYYY-MM-DD` in Durham, which sorts and compares as text, and weekdays count from Monday.

## Map

### Data

- **Live**: the Umo IQ rider API (`api.prd-1.iq.live.umoiq.com/v2.0/riders/agencies/unh`), the backend of `rider.umoiq.com` and the Umo apps. No key, open CORS, so browsers poll it directly: vehicles every 5 s, and predictions every 30 s for routes with a bus out.
- **Schedule**: Wildcat Transit's GTFS feed on National RTAP (the one Google Maps uses). The host has no CORS, so `npm run data` converts it into `src/map/gtfs.json` at build time, and CI rebuilds nightly. Umo's trip and stop ids match the GTFS ones, so predictions shift the timetable per trip.
- **Walking paths**: FOSSGIS's public OSRM foot router. **Place search**: Photon.
- **Laundry and dining buildings**: OpenStreetMap coordinates saved in `scripts/map/buildings.json`, used by `scripts/map/places.mts` to generate `src/map/places.json`. Refresh the coordinates explicitly with `npm run places:refresh`; ordinary builds do not call Overpass. The laundry vendor puts every room at the same spot, so rooms are matched to their residence halls by name, with a small alias table where OSM names a building otherwise; a room or hall left unmatched fails the build. The map shows them quietly and plans to one when it's tapped, and `/map/?to=laundry/<room>` or `?to=dining/<hall>`, as the laundry and dining pages link, plans there from your location.

Buses are drawn where they likely are now, not just where they last reported: each one drives along its route and waits at each stop as long as the model expects at this time of day, scaled by how slow or quick buses on that line have been in the last half hour, nudged toward what the last bus took on that very stretch, and held at stops where its trip waits for the timetable.

Trip planning is a Connection Scan over the timetable plus live delays, with a reverse scan so each option leaves as late as possible. Within the stretch Umo is predicting a route, trips it doesn't mention are dropped (the campus connectors run by headway, not to the timetable).

### The model

Each build fits `src/map/model.json` (`scripts/map/model.mts`), bundled like the timetable. For every completed service day since the last model, it extracts each bus's visits to stops from the Worker's samples (`src/map/events.mts`, with the same snapping and zone crossing the map uses), stores them back in D1 as `visits`, which outlast the samples, and folds them into decayed statistics with a 4-week half-life (`src/map/model.mts`, on the fold in `src/shared/learn.mts`): drive times between stops by weekday or weekend and time of day, time at each stop, whether early buses wait at a stop for their scheduled time, layovers between trips, and how far off the timetable each route runs. Every estimate leans on a broader one while it has little data (a stretch at any time, then the route's pace), and an empty model has none, so the map falls back on its old constants. Each day is also scored (`scripts/map/replay.mts`): at 1, 3, 5, 10, and 20 minutes before each departure, how far off the timetable, the model from where the bus was, and Umo's own prediction were, which calibrates how much slack the planner leaves. The planner learns holds, layovers, and slack from it; Umo's predictions still set the delays.

Everything goes through the Worker's token-gated `/api/rows/:name` and `/api/models/:name` (see Deploying), so the build needs only `BUILD_TOKEN`, never D1 credentials. Without it, or the Worker, the last model stays (or an empty one), so the model never fails the build. `npm run model -- --rebuild` refits from every stored visit, extracting again where samples are still kept.

## Dining

Menus come from Nutrislice (`unh.api.nutrislice.com`, behind `unh.nutrislice.com`): a week per hall and meal, with stations, ingredients, diet and allergen tags, and nutrition, published about two weeks ahead. It has no CORS, so `npm run data` fetches today through the end of what's posted, and splits it so the page only loads what it shows:

- `src/dining/menus.json`, the index the page bundles: halls, which meals each hall serves each day, and the name of every other file
- under `public/data/dining/`, each named by a hash of what's in it:
  - a file per hall per day, with each food's name, tags, and calories (about 2 KB gzipped)
  - a file per food, with its ingredients and nutrition, loaded when it's opened; a food served all week is one file, and stays cached across nightly rebuilds
  - every upcoming food with its ingredients and servings, loaded on the first search

The page tells the service worker which files the index still names, and it drops the rest from its cache. Search, filters, and everything else run in the browser.

## Laundry

The rooms' Speed Queen machines report to LaundryConnect (`laundryconnectlive.com`), which has no CORS, so the page asks the Worker. The room list reads `/api/laundry/rooms`, every room's free washers and dryers as the collector last saw them, made from D1 alone and shared at the edge for 5 minutes, so the list never reaches the vendor. An open room reads `/api/laundry/rooms/:id`, which fetches it live with the asker's own User-Agent and shares the answer for 30 s, falling back to the collector's last record (marked stale) when the vendor can't answer. `npm run data` lists the rooms into `src/laundry/rooms.json`, each with the slug of its address.

Each room has its own address, `/laundry/<room>/`: the Worker answers it with the laundry page (any other `/laundry/…` is a 404), the page moves between rooms with `history.pushState`, the service worker keeps the one laundry page for every room offline, and `vite.config.mts` does the same in development.

`src/laundry/infer.mts` decides what to claim about each machine: a running machine's countdown is its own while it keeps reporting, a quiet one past its end is probably done, and a finished one sits done until its door opens.

The Worker's laundry cron polls every room every 5 minutes (15 overnight), a quarter of the rooms each minute between the fifths, and writes status changes to D1 (`transitions`, `latest`, `polls`) plus one current snapshot per room (`room_snapshots`), keeping heartbeats and timers fresh without repeating every machine row, all in epoch milliseconds. Each build (`scripts/laundry/model.mts`) folds every whole day since the last into what it has learned (`src/laundry/model.mts`, on the same fold as the bus model), reading the day's rows from `/api/rows/:name` and storing the result with `/api/models/laundry`, and writes `src/laundry/usual.json`: for every room, kind, and hour of the week, the time-weighted free count and chance of any free, decayed with a 4-week half-life, leaving out stretches nobody watched and days a room was nearly idle, like breaks. Without `BUILD_TOKEN` or the Worker it keeps what it has, so it never fails the build.

## Commands

```sh
npm run dev        # http://localhost:5173, fetching data first if it's missing
npm run data       # refresh the bus schedule and menus from upstream
npm run icons      # regenerate app PNG icons from public/icon.svg
npm test           # property tests (vitest + fast-check)
npm run typecheck
npm run worker     # the Worker on http://localhost:8787 with a local D1, crons fired by
                   # curl "localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
npm run model -- --local  # fit the bus model from it, with BUILD_TOKEN set here and in .dev.vars
npm run db:generate       # a migration in worker/migrations for changes to worker/schema.mts
npm run db:migrate # apply production D1 migrations
npm run deploy     # migrations, then deploy the existing build
npm run deploy:fresh # fresh data, build, then deploy with migrations
```

## Deploying

Cloudflare Workers Builds builds and deploys the `notunh` Worker from this repo's `main` (Cloudflare dashboard, Worker → Settings → Build), on every push:

- Build command: `npm run build`, which in a fresh clone downloads the day's data, then typechecks and tests before building
- Deploy command: `npm run deploy`. Its `predeploy` script applies D1 migrations first; a migration failure stops deployment. Keep migration and deployment steps in `package.json`, so future changes don't require editing the dashboard command.

If upstream is down the build fails and the last deploy stays up. Cloudflare preview builds remain enabled. **Check** (GitHub Actions) also typechecks, tests, and builds each pull request without secrets.

The Worker (`worker/`) is a small [Hono](https://hono.dev) app that only answers `/api/*` and the laundry rooms' addresses (`run_worker_first` in `wrangler.jsonc`); every other page and asset is served without it. Its cron triggers keep raw samples of the live API in the D1 database `notunh`, one gzipped row per source per minute (`src/map/raw.mts`): the buses' fixes polled six times a minute, and Umo's predictions every 5 minutes; and the laundry collector's changes. Its tables are in `worker/schema.mts` (Drizzle), with migrations generated from it. Nightly at 4:17 AM (3:17 in winter, as cron runs in UTC) it prunes samples, laundry transitions, and polls past `RETAIN_DAYS` (60) and extracted visits past `RETAIN_VISIT_DAYS` (365), and POSTs the Deploy Hook (Worker secret `DEPLOY_HOOK`), so Cloudflare rebuilds with fresh menus, timetable, and models.

The API, in `worker/api.mts`:

- `GET /api/health`, public: when each table's rows start and when the last was stored, in its own unit, and the day each model runs through
- `GET /api/rows/:name?day=YYYY-MM-DD&after=…` and `POST /api/rows/:name` (`{ rows, clear? }`): a page of rows from one table in the registry (`worker/rows.mts`: `buses`, `predictions`, `visits`, `transitions`, `polls`, `machines`), by Durham day or service day where the table has one, and writing the tables the build writes
- `GET /api/models/:name` and `POST /api/models/:name`: the latest stored state of `buses` or `laundry`, and a new one
- `GET /api/laundry/rooms` and `GET /api/laundry/rooms/:id`, public, as in Laundry

The rows and models routes take `Authorization: Bearer $BUILD_TOKEN`, a Worker secret also set as a build variable, and answer 401 without it. Build steps reach them through `scripts/worker.mts`, which can also be run to look: `BUILD_TOKEN=… node scripts/worker.mts health`, or `rows <name> [day]`, with `--local` for `npm run worker`.

**Refresh** (GitHub Actions) POSTs the same hook on demand, with `gh workflow run refresh.yml` (repository secret `CLOUDFLARE_DEPLOY_HOOK`).
