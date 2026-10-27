# Development

Node 24+. Every `*.html.tsx` is a page (vite-plugin-bruh): `/` (`index.html.tsx`), `/map/`, `/dining/`, `/laundry/`, and `/p/` (an event's light page, `src/social/`). The browser floor is Safari/iOS 16.4 (`browserslist` in `package.json`, checked by `tests/shell/compat.test.mts`).

## Layout

```
src/shared/       Pure helpers for pages, Worker, and scripts: Durham time, the learned-model fold, hashing, visits, sync merge
src/geo/          Projections, lines in meters, boxes, map matching
src/places/       Gazetteer, place search, Photon, laundry and dining buildings
src/transit/      The GTFS timetable and route shapes
  observations/   What was observed: stored rows, the archive, Umo as a live source
  inference/      What's inferred from fixes: the location model and visit extraction
  models/         The learned model, its fit, bus movement, tracking, the forecast
src/routing/      Walking network, walks, the trip planner
src/reminders/    Reminders, watches and class queues; browser/ keeps them and talks to the Worker
src/social/       Events and pins: the shape, the calendars' readers, marks, links, the story image, the /p/ page
src/courses/      Sections, the academic calendar, instructors, rooms, saved sections, the calendar file
src/programs/     The catalog's prerequisites and programs, and a program's graph
src/parking/      Parking areas' rules and the verdict for a stay
src/shell/        Shared page shell: <head>, theme, Intl, polling, release manifests, data loading, state and sync
src/sw/           The service worker, built to /sw.js
src/map/          The map page: state/ (createMapState, nothing started on import), render/ (MapLibre), ui/, basemap/
src/dining/, src/laundry/   Those pages: state.mts, ui/, and their logic
worker/           The Cloudflare Worker (Hono, Drizzle on D1)
scripts/          The data pipeline: inputs, learning and replay, archiving, map data, deploy steps
tests/            Vitest + fast-check, mirroring src/; tests/browser/ is Playwright
```

Domain layers import only the layers beneath them (`LAYERS` in `tests/layers.test.mts`, which checks every import):

```
shared ← geo ← places
shared ← social ← courses;  shared ← programs;  shared ← geo ← routing ← parking
shared ← geo ← transit ──────┐
shared ← transit/observations ┴─ ← transit/inference ← transit/models ← routing (also on places) ← reminders
```

- Observations as stored never depend on what's inferred from them.
- No domain imports bruh, MapLibre, a browser global, or a page's state, render, or UI. Neither do `worker/` or `scripts/`, so learning and replay run the map's own code.

## Conventions

- Every boundary (upstream APIs, data files, Worker request bodies) is a [Valibot](https://valibot.dev) schema, which also gives its type. Upstream answers keep the items that fit, so an upstream change shows less rather than garbage.
- Positions are `[lon, lat]` or `{ lat, lon }`. Boxes are `[west, south, east, north]`. Distances are meters on cheap-ruler's projection, made only in `src/geo/projection.mts`.
- Instants crossing a boundary are epoch milliseconds. Times compared with the timetable are schedule seconds from the service day's start. The location model uses epoch seconds internally.
- A calendar day is a `Day`, `YYYY-MM-DD` in Durham. Weekdays count from Monday.
- Bytes flow as async iterables of `Uint8Array`. Anything a page or the Worker reads is gzip (Safari 16.4's `DecompressionStream` has no zstd); only the observations archive, read by scripts alone, is zstd.

## Scripts

```sh
npm run test:browser  # Chromium and WebKit (once: npx playwright install chromium webkit); NOTUNH_DIST names a build to reuse
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

- `NOTUNH_OFFLINE=1`: fetch nothing upstream or from GitHub; install `tests/fixtures/data/` as inputs and map data. Pull requests build this way.
- `NOTUNH_INPUTS`, `NOTUNH_MAP_DATA`: pin what a build or `npm run dev` installs, by version, or for inputs a folder path starting with `.` or `/` (`./inputs` from `npm run fresh` or one stage). Unset, the releases' pointers decide. Inputs from before events, courses, prerequisites or parking existed: `npm run dev` fills those from the fixtures; a build ships them empty, but for parking, whose fixtures are as good.
- `BUILD_TOKEN`: the Worker's bearer token for its private routes, which learning, archiving, and `npm run storage` use instead of D1 credentials. Locally, in the environment and `.dev.vars`.
- Learning flags: `--store` writes what's learned to D1, which production then uses; without it, learning only reads. `--rebuild` learns afresh from the first day observed.

## Data sources

Nightly unless said; each stage is `node scripts/<stage>.mts` (`scripts/data.mts` lists them).

| Data | Source | Stage, and more |
|---|---|---|
| Buses | Umo IQ rider API | None: browsers poll it, the Worker stores it ([transit.md](transit.md)) |
| Timetable | Wildcat Transit GTFS on National RTAP (no CORS) | `map/gtfs` |
| Map | Geofabrik's New Hampshire extract | Weekly: walking, gazetteer, OSM parking, tiles ([map.md](map.md)) |
| Base map | OpenFreeMap's Liberty style | `map/style`, partly self-hosted |
| Addresses | Photon (komoot) | Asked by the page while searching |
| Events | Presence (Wildcat Link), 25Live (unh.edu/calendar), unhwildcats.com, DSE Rec Club Sports (`unh.dserec.com`) | `map/events` ([social.md](social.md#official-events)) |
| Courses | Registrar's course API (`wapi.unh.edu/dhub`, courses.unh.edu's own), 25Live's academic calendar | `map/courses`, `--cache <folder>` reuses answers under a day old ([courses.md](courses.md)) |
| Prerequisites, programs | catalog.unh.edu | `programs/prereqs`, read weekly; `--from <folder> --programs <folder>` reads pages kept ([programs.md](programs.md)) |
| Parking | UNH's visitor page and zone table PDF, ParkMobile's zones, OSM's parking areas; rules by hand in `src/parking/areas.mts` | `map/parking` checks the rules, `--cached` against the fixtures ([parking.md](parking.md)) |
| Fraternities and sororities | UNH's chapter scorecards and unrecognized organizations pages, Wildcat Link, the national organizations' and chapters' sites; houses from Durham's parcels and OSM | None: reviewed by hand in `src/places/chapters.mts` ([map.md](map.md#places)) |
| Menus | Nutrislice | `dining/menus` |
| Laundry | LaundryConnect (`laundryconnectlive.com`) | Only through the Worker ([worker.md](worker.md#laundry)) |
