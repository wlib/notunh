# notunh

The better UNH app, at [notunh.app](https://notunh.app): a PWA built with Vite and [bruh](https://github.com/Technical-Source/bruh), served as static assets from Cloudflare Workers.

Each section is its own page and bundle, sharing a shell (`src/shell/`: the `<head>`, theme, icons, Intl formatting, and the service worker):

- `/` (`index.html.tsx`): what's here, who made it, and where the data comes from
- `/map/` (`map/index.html.tsx`, `src/map/`): live Wildcat Transit buses and routes on MapLibre GL with the OpenFreeMap Liberty style, and bus + walking directions
- `/dining/` (`dining/index.html.tsx`, `src/dining/`): dining hall menus, with search by food or ingredient and diet and allergen filters

Within a section, `state.mts` holds the reactive state and live data, `ui/` the components, and the rest the logic, with the pure parts property tested. Each npm package builds into its own chunk, so a change to the app leaves maplibre cached.

## Map

### Data

- **Live**: the Umo IQ rider API (`api.prd-1.iq.live.umoiq.com/v2.0/riders/agencies/unh`), the backend of `rider.umoiq.com` and the Umo apps. No key, open CORS, so browsers poll it directly: vehicles every 5 s, and predictions every 30 s for routes with a bus out.
- **Schedule**: Wildcat Transit's GTFS feed on National RTAP (the one Google Maps uses). The host has no CORS, so `npm run data` converts it into `src/map/gtfs.json` at build time, and CI rebuilds nightly. Umo's trip and stop ids match the GTFS ones, so predictions shift the timetable per trip.
- **Walking paths**: FOSSGIS's public OSRM foot router. **Place search**: Photon.

Buses are drawn where they likely are now, not just where they last reported: each one drives along its route at the pace the last bus drove that stretch between stops, and waits at each stop as long as the last bus there did, all learned in the browser from every bus's reports.

Trip planning is a Connection Scan over the timetable plus live delays, with a reverse scan so each option leaves as late as possible. Within the stretch Umo is predicting a route, trips it doesn't mention are dropped (the campus connectors run by headway, not to the timetable).

## Dining

Menus come from Nutrislice (`unh.api.nutrislice.com`, behind `unh.nutrislice.com`): a week per hall and meal, with stations, ingredients, diet and allergen tags, and nutrition, published about two weeks ahead. It has no CORS, so `npm run data` fetches today through the end of what's posted, and splits it so the page only loads what it shows:

- `src/dining/menus.json`, the index the page bundles: halls, which meals each hall serves each day, and the name of every other file
- under `public/data/dining/`, each named by a hash of what's in it:
  - a file per hall per day, with each food's name, tags, and calories (about 2 KB gzipped)
  - a file per food, with its ingredients and nutrition, loaded when it's opened; a food served all week is one file, and stays cached across nightly rebuilds
  - every upcoming food with its ingredients and servings, loaded on the first search

The page tells the service worker which files the index still names, and it drops the rest from its cache. Search, filters, and everything else run in the browser.

## Commands

```sh
npm run dev        # http://localhost:5173, fetching data first if it's missing
npm run data       # refresh the bus schedule and menus from upstream
npm run icons      # regenerate app PNG icons from public/icon.svg
npm test           # property tests (vitest + fast-check)
npm run typecheck
npm run deploy     # fresh data, build, then wrangler deploy
```

## Deploying

Cloudflare Workers Builds builds and deploys the `notunh` Worker from this repo's `main` (Cloudflare dashboard, Worker → Settings → Build), on every push:

- Build command: `npm run build`, which in a fresh clone downloads the day's data, then typechecks and tests before building
- Deploy command: `npx wrangler deploy`

If upstream is down the build fails and the last deploy stays up. Preview builds are off, since **Check** (GitHub Actions) already typechecks, tests, and builds each pull request.

**Refresh** (GitHub Actions) POSTs the Worker's Deploy Hook nightly, and on demand with `gh workflow run refresh.yml`, so Cloudflare rebuilds with fresh menus and timetable. The hook URL, repository secret `CLOUDFLARE_DEPLOY_HOOK`, is the only secret anywhere. GitHub pauses the schedule after 60 days without a commit.
