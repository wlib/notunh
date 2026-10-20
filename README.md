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
scripts/          The pipeline: acquiring and installing inputs, model training and replay, archiving, map data
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
- Instants are **epoch milliseconds** wherever they cross a boundary (Worker rows, API JSON, page state, all of laundry). Times compared with the timetable are **schedule seconds** from the service day's start (the planner, the bus model, the visits derived from observations). The location model works in epoch seconds internally.
- A calendar day is a `Day`, `YYYY-MM-DD` in Durham, which sorts as text; weekdays count from Monday.
- Bytes flow as async iterables of `Uint8Array`; gzip wherever a page or the Worker reads it, zstd only for the observations archive, which only scripts read.

## Running

```sh
npm run dev           # http://localhost:5173, after installing the inputs and map data the releases point at
npm test              # vitest + fast-check
npm run test:browser  # the service worker in Chromium and WebKit (once: npx playwright install chromium webkit)
npm run typecheck
npm run worker        # the Worker on http://localhost:8787 with a local D1; fire a cron with
                      # curl "localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
npm run fresh         # the whole pipeline locally: acquire from upstream, learn, and build from those inputs
                      # (`node scripts/data.mts acquire` or `learn` for one stage; `-- --store` to store what's learned)
npm run fixtures      # remake tests/fixtures/data from the data installed
npm run icons         # regenerate PNG icons from public/icon.svg
npm run model -- --local --store   # fit the bus model against `npm run worker` (BUILD_TOKEN here and in .dev.vars)
npm run storage       # D1's size in bytes and rows per table (needs BUILD_TOKEN)
npm run db:generate   # a migration in worker/migrations/ for changes to worker/schema.mts
```

Environment:
- `NOTUNH_OFFLINE=1` asks nothing upstream or of GitHub: the fixtures in `tests/fixtures/data/` are installed as the inputs and map data. Pull requests build this way.
- `NOTUNH_INPUTS` and `NOTUNH_MAP_DATA` pin what a build or `npm run dev` installs: a generation's version, or for the inputs a folder laid out as the repository, given by a path starting with `.` or `/`, like `./inputs`, where `npm run fresh` makes them. Without them, it's what the releases' pointers name.
- `BUILD_TOKEN` is the Worker's bearer token for its rows, models, timetables, and storage routes, which learning and archiving use instead of D1 credentials. `--store` asks learning to store what it learns in D1, which production then uses; without it, learning only reads. `--rebuild` learns afresh from the first day observed.

## Building and deploying

Building only installs what it's pinned to and builds; collecting, archiving, acquiring, and learning are steps of their own that publish what a build takes ([docs/storage.md](docs/storage.md#the-pipeline)). Cloudflare Workers Builds builds `main` on every push and whenever a workflow publishes new inputs or map data (it POSTs the Deploy Hook). The build command is `npm run build`, the deploy command `npm run deploy`. Keep both steps in `package.json` so the dashboard never needs editing.

1. `prebuild` installs the inputs and map data generations the releases' pointers name (`scripts/inputs.mts`), keeps what the site serves now beside them for open pages, matches the places, and runs the typecheck and tests. It needs no secrets and writes nothing but its own folder, so any branch's build is safe.
2. `vite build`, then `postbuild` (`scripts/search.mts`) adds the social images, the sitemap, and IndexNow's key file.
3. `predeploy` applies D1 migrations (`npm run db:migrate`); a failed migration stops the deploy.
4. `wrangler deploy` ships the Worker and site together.
5. `postdeploy` (`scripts/indexnow.mts`) submits the pages the deploy changed to IndexNow, on Workers Builds' deploys of `main` only.

Each night the Worker's 4:17 AM cron starts the Inputs workflow, which acquires the timetable, style, menus, and laundry rooms, runs the tests, learns the models through the Worker, builds the site with all of that to check it, publishes it as `inputs-<version>`, and POSTs the Deploy Hook. If upstream is down, nothing is published and the site keeps the inputs before. Both learners are attempted when either stalls; compatible previous or empty outputs can still be published, and the workflow reports the stall afterward. A hard failure that leaves a required model or asset missing prevents publication. Installation validates the complete input bundle before clearing the prior generated sources, so fixtures cannot fill gaps in production inputs. Rerunning publication retries the Deploy Hook even if its pointer already advanced. `/inputs.json` on the site says which inputs and map data it was built from.

**Rolling back.** Clients never step back to a release older than the one they have, so `wrangler rollback` only reaches new visitors. To go back for everyone, publish the old release again: rebuild its commit with the `NOTUNH_INPUTS` and `NOTUNH_MAP_DATA` its `/inputs.json` names, or stamp a folder an old build wrote with `node scripts/republish.mts <folder>` and deploy it with `wrangler deploy --assets <folder>` (after `npm run db:migrate`; Worker versions don't roll D1 back).

**Dropping `visits`.** Once no rollback to a Worker from before October 2026 is wanted, `git mv worker/migrations/after-deploy/0003_drop_visits.sql worker/migrations/` and push; the next deploy drops the old table. Not before: those Workers delete from it in their nightly prune, which would fail every night without it.

### Workflows and secrets

| Workflow | When | Does | Needs |
|---|---|---|---|
| Check (`check.yml`) | Pull requests | Offline build with fixtures, unit and browser tests | Nothing (read-only token, no secrets) |
| Inputs (`inputs.yml`) | Worker dispatch nightly, or by hand (`-f rebuild=true` to learn afresh) | Acquires the timetable, style, menus, and rooms, learns the models, publishes them as release `inputs-<version>`, then rebuilds the site | `BUILD_TOKEN`, `CLOUDFLARE_DEPLOY_HOOK` |
| Observations (`archive.yml`) | Nightly 9:30 UTC, Worker dispatch, or `-f from= -f to=` | Archives each settled service day's samples as release `observations-<day>` and updates `catalog.json` | `BUILD_TOKEN` |
| Map data (`map.yml`) | Mondays, Worker dispatch, or by hand | Builds walk network, gazetteer, and tiles from OSM as release `map-data-<version>`, then rebuilds the site | `CLOUDFLARE_DEPLOY_HOOK` (optional) |

Secrets live on two sides, and `node scripts/secrets.mts check` says whether each is set:

- The Worker: `BUILD_TOKEN` and `GITHUB_TOKEN`, a fine-grained token with Actions read and write on this repository, which starts its workflows. The Worker's nightly run starts Observations and Inputs every night, and Map data on Mondays. Inputs has no schedule of its own, since GitHub pauses schedules after 60 days without a commit, so without `GITHUB_TOKEN` the site keeps the inputs it has.
- The `production` environment on GitHub, which only `main` can use: `BUILD_TOKEN` and `CLOUDFLARE_DEPLOY_HOOK`, the URL of a Workers Builds deploy hook of `main`. Inputs and Map data record each run as a deployment of notunh.app.

`BUILD_TOKEN` is on both sides and in `.dev.vars`, so it's only changed with `node scripts/secrets.mts rotate`, which sets all three.

## Search and sharing

- Each page's title, description, and structured data are in `src/shell/pages.mts`, which `Head.tsx` makes into the canonical URL, Open Graph and Twitter cards, and JSON-LD (`WebSite` on the home page for Google's site name, a free `WebApplication` on each). No ratings, so no rich result.
- `/map/`, `/dining/`, and `/laundry/` render their header and what they do on the server, and laundry every room as a link, so crawlers and link previews see more than an empty `#app`. `src/shell/ui.tsx` renders on either side: `#jsx` is bruh's browser or server JSX by the build's conditions (`imports` in `package.json`).
- Laundry rooms (`/laundry/<room>/`) are the laundry page itself, so their canonical URL is `/laundry/` and they're not in the sitemap. Their only content of their own is live.
- At build: `/social/<page>/card.png` per page (`scripts/social.mts`, text drawn as Inter's outlines so no fonts need be installed), `/sitemap.xml`, and `/<key>.txt`. A page's `lastmod` is this build's release only if the page differs from the one served by more than its release, so nightly menus move dining's and leave the home page's.
- After a deploy: changed pages go to IndexNow (Bing, Yandex, Naver, Seznam, Yep). Google has nothing like it for these pages; it reads the sitemap that `robots.txt` names.
- Cloudflare's managed robots.txt prepends its content signals to `public/robots.txt`, so nothing needs toggling.

Once, by hand:
- Google Search Console: add the domain property `notunh.app`, verify it with the TXT record it gives, added in Cloudflare DNS, then submit `https://notunh.app/sitemap.xml` under Sitemaps.
- Bing Webmaster Tools: import the site from Search Console, which also covers IndexNow's reports.
- Check previews with the [Rich Results Test](https://search.google.com/test/rich-results) and a link pasted in iMessage, Slack, or Discord.

## Data sources

- **Buses**: the Umo IQ rider API (no key, open CORS), polled by browsers directly and archived by the Worker's crons.
- **Timetable**: Wildcat Transit's GTFS feed on National RTAP, converted nightly as an input (no CORS). Umo's trip and stop ids match it.
- **OpenStreetMap**: Geofabrik's New Hampshire extract, made weekly into the walking network, gazetteer, and tiles.
- **Base map**: OpenFreeMap's Liberty style, restyled and partly self-hosted, acquired nightly as an input.
- **Menus**: Nutrislice, acquired nightly as an input and split into content-addressed files under `public/data/dining/`.
- **Laundry**: LaundryConnect (Speed Queen), through the Worker. The proxy forwards the asker's own User-Agent; the cron sends none and polls each room every 5 minutes (15 overnight). Nothing else asks the vendor.

## Further notes

- [docs/offline.md](docs/offline.md): the service worker, release manifests, live data swaps, retention, and iOS quirks
- [docs/transit.md](docs/transit.md): the location model, bus movement, the forecaster, the learned model, and trip planning
- [docs/map.md](docs/map.md): map data generation, tiles, the base map, walking, and place search
- [docs/worker.md](docs/worker.md): the Worker's API, crons, and the laundry collector and model
- [docs/storage.md](docs/storage.md): every artifact and table, its version, where it lives, and how long it's kept
