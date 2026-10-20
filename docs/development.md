# Development

Node 24+. Every `*.html.tsx` is a page (vite-plugin-bruh): `/` (`index.html.tsx`), `/map/`, `/dining/`, and `/laundry/`, each with its code under `src/<page>/`. The browser floor is Safari/iOS 16.4 (`browserslist` in `package.json`, checked by `tests/shell/compat.test.mts`).

## Layout

```
src/shared/       Pure helpers for pages, Worker, and scripts: Durham time, the learned-model fold, hashing, slugs
src/geo/          Projections, lines in meters, boxes, map matching
src/places/       Gazetteer, place search, Photon, laundry and dining buildings
src/transit/      The GTFS timetable and route shapes
  observations/   What was observed: stored rows, the archive, Umo as a live source
  inference/      What's inferred from fixes: the location model and visit extraction
  models/         The learned model, its fit, bus movement, tracking, the forecast
src/routing/      Walking network, walks, the trip planner
src/shell/        Shared page shell: <head>, theme, Intl, polling, release manifests, data loading
src/sw/           The service worker, built to /sw.js
src/map/          The map page: state/ (createMapState, nothing started on import), render/ (MapLibre), ui/, basemap/
src/dining/, src/laundry/   Those pages: state.mts, ui/, and their logic
worker/           The Cloudflare Worker (Hono, Drizzle on D1)
scripts/          The data pipeline: inputs, learning and replay, archiving, map data, deploy steps
tests/            Vitest + fast-check, mirroring src/; tests/browser/ runs the service worker in Playwright
```

Domain layers import only the layers beneath them:

```
shared ← geo ← places
shared ← geo ← transit ──────┐
shared ← transit/observations ┴─ ← transit/inference ← transit/models ← routing (also on places)
```

- Observations as stored never depend on what's inferred from them.
- No domain imports bruh, MapLibre, or a page's state, render, or UI. Neither do `worker/` or `scripts/`, so learning and replay run on exactly the code the map runs.
- `tests/layers.test.mts` checks every import.

## Conventions

- Every boundary (upstream APIs, data files, Worker request bodies) is checked by a [Valibot](https://valibot.dev) schema, which also gives its type. Upstream answers keep the items that fit, so an upstream change shows less rather than garbage.
- Positions are `[lon, lat]` or `{ lat, lon }`. Boxes are `[west, south, east, north]`. Distances are meters on cheap-ruler's projection, made only in `src/geo/projection.mts`.
- Instants crossing a boundary are epoch milliseconds. Times compared with the timetable are schedule seconds from the service day's start. The location model uses epoch seconds internally.
- A calendar day is a `Day`, `YYYY-MM-DD` in Durham. Weekdays count from Monday.
- Bytes flow as async iterables of `Uint8Array`. Anything a page or the Worker reads is gzip (Safari 16.4's `DecompressionStream` has no zstd); only the observations archive, read by scripts alone, is zstd.

## Scripts

```sh
npm run test:browser  # service worker in Chromium and WebKit (once: npx playwright install chromium webkit)
npm run worker        # then fire a cron: curl "localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
npm run fresh         # the whole pipeline locally into ./inputs: acquire, learn, build
                      # (node scripts/data.mts acquire|learn for one stage; -- --store to store what's learned)
npm run model -- --local --store   # fit the bus model against npm run worker
npm run storage       # D1's size and rows per table
npm run db:generate   # a migration in worker/migrations/ for changes to worker/schema.mts
npm run fixtures      # remake tests/fixtures/data from the installed data
npm run icons         # PNG icons from public/icon.svg
npm run social        # link preview images (see deploying.md)
```

## Environment

- `NOTUNH_OFFLINE=1`: fetch nothing upstream or from GitHub; install the fixtures in `tests/fixtures/data/` as inputs and map data. Pull requests build this way.
- `NOTUNH_INPUTS`, `NOTUNH_MAP_DATA`: pin what a build or `npm run dev` installs, by version. `NOTUNH_INPUTS` also takes a folder path starting with `.` or `/`, like `./inputs` from `npm run fresh`. Unset, the releases' pointers decide.
- `BUILD_TOKEN`: the Worker's bearer token for its private routes, which learning, archiving, and `npm run storage` use instead of D1 credentials. Locally it goes in the environment and `.dev.vars`.
- Learning flags: `--store` writes what's learned to D1, which production then uses (without it, learning only reads). `--rebuild` learns afresh from the first day observed.

## Data sources

| Data | Source | How |
|---|---|---|
| Buses | Umo IQ rider API | Polled by browsers directly; stored by the Worker ([transit.md](transit.md)) |
| Timetable | Wildcat Transit GTFS on National RTAP | Converted nightly as an input (no CORS) |
| Map | Geofabrik's New Hampshire extract | Walking network, gazetteer, and tiles, weekly ([map.md](map.md)) |
| Base map | OpenFreeMap's Liberty style | Restyled, partly self-hosted, nightly |
| Menus | Nutrislice | Acquired nightly into content-addressed files under `public/data/dining/` |
| Laundry | LaundryConnect (Speed Queen) | Only through the Worker ([worker.md](worker.md#laundry)) |
