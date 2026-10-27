# Deploying

The site and API are one Cloudflare Worker (`wrangler.jsonc`), on Workers Paid, serving the built pages as static assets, with D1 as its database. Workers Builds builds `main` on every push and whenever a workflow POSTs the Deploy Hook, running `npm run build` then `npm run deploy`; keep the steps in `package.json` so the dashboard never needs editing.

## The pipeline

Each step makes one thing and the next takes it as made, pinned by version. What each keeps is in [storage.md](storage.md).

| Step | Runs | Makes |
|---|---|---|
| Collect | The Worker's crons | `samples` and laundry tables in D1 |
| Archive | `archive.yml`, nightly | `observations-<day>` releases and `catalog.json` |
| Map data | `map.yml`, Mondays | `map-data-<version>` releases and their pointer ([map.md](map.md)) |
| Inputs | `inputs.yml`, nightly | `inputs-<version>` releases and their pointer, then the Deploy Hook |
| Build | Workers Builds | The site and the Worker |

**Inputs** is the site's nightly clock, started by the Worker's 4:17 AM cron. It acquires the timetable, style, events, courses, menus, laundry rooms, parking areas and prerequisites (`node scripts/data.mts acquire`), runs the tests, learns the bus and laundry models through the Worker (`learn --store`), builds the site to check it all, publishes the release, and POSTs the Deploy Hook.

- If upstream is down, nothing is published and the site keeps its inputs.
- If one learner stalls, the other still runs; compatible previous or empty outputs may be published, and the run fails afterward. A required model or asset missing blocks publication.
- Installation validates the whole bundle before clearing the old sources, so fixtures never fill gaps in production inputs.
- Rerunning a publication retries the Deploy Hook even if the pointer already moved.

**Releases.** A generation is published only when its pointer doesn't already name it (`stage` in `scripts/release.mts`), so overlapping runs can't double-publish. It's immutable once its manifest is up (`.github/actions/publish`); one left without is filled in again. Pointers (`latest.json`) and `catalog.json` go up last. The catalog is only merged into, so the Worker never prunes a day whose archive isn't whole, and each Archive run takes every settled day D1 has that the catalog lacks, oldest first, catching up after failures.

Nothing deletes releases. Old `inputs-*` and `map-data-*` releases are safe to delete by hand once no build pins them and you won't rebuild an old site with its own inputs.

## Build and deploy

1. `prebuild` installs the inputs and map data the pointers name (`scripts/inputs.mts`), keeps what the site serves now beside them for open tabs, matches places, and runs the typecheck and tests. It needs no secrets and writes only its own folder, so any branch's build is safe.
2. `vite build`, then `postbuild` (`scripts/search.mts`) writes the sitemap and IndexNow's key file.
3. `predeploy` applies D1 migrations (`npm run db:migrate`). A failed migration stops the deploy.
4. `wrangler deploy` ships the Worker and site together.
5. `postdeploy` (`scripts/indexnow.mts`) submits changed pages to IndexNow, on Workers Builds' deploys of `main` only.

`/inputs.json` names the inputs and map data a site was built from. Migrations run while the previous Worker still serves ([worker.md](worker.md#schema-changes)).

## Workflows and secrets

| Workflow | When | Needs |
|---|---|---|
| Check (`check.yml`) | Pull requests: offline build and unit tests | Nothing (read-only token) |
| Inputs (`inputs.yml`) | Worker dispatch nightly, or by hand (`-f rebuild=true` to learn afresh) | `BUILD_TOKEN`, `CLOUDFLARE_DEPLOY_HOOK` |
| Observations (`archive.yml`) | 9:30 UTC nightly, Worker dispatch, or `-f from=<day> -f to=<day>` | `BUILD_TOKEN` |
| Map data (`map.yml`) | Mondays, Worker dispatch, or by hand | `CLOUDFLARE_DEPLOY_HOOK` (optional) |

`node scripts/secrets.mts check` says whether each secret is set.

- **Worker**: `BUILD_TOKEN`; `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, which reminders are pushed with; and `GITHUB_TOKEN`, fine-grained with Actions read and write on this repository, for the nightly cron to start Observations, Inputs, and Map data on Mondays. Inputs has no schedule of its own, as GitHub pauses schedules after 60 days without a commit. Without `GITHUB_TOKEN` the site keeps its last inputs, map data goes stale, and samples pile up in D1 until archiving resumes.
- **GitHub `production` environment** (`main` only): `BUILD_TOKEN`, and `CLOUDFLARE_DEPLOY_HOOK`, a Workers Builds deploy hook URL for `main`. Inputs and Map data record each run as a deployment of notunh.app.

`BUILD_TOKEN` is on both sides and in `.dev.vars`, so change it only with `node scripts/secrets.mts rotate`, which sets all three. `node scripts/secrets.mts vapid` makes push keys where missing: the Worker's pair, never shown and never replaced (a new pair cuts off every subscribed device), and another for `.dev.vars`.

**Email** needs no secret: codes go through Email Service's `send_email` binding once `notunh.app` is onboarded as a sending domain ([social.md](social.md#sending-the-code)); until then, sending a code answers 502.

## Rolling back

Clients never step back to a release older than theirs ([offline.md](offline.md)), so `wrangler rollback` only reaches new visitors. To go back for everyone, publish the old release again:

- rebuild its commit with the `NOTUNH_INPUTS` and `NOTUNH_MAP_DATA` its `/inputs.json` names, or
- stamp a folder an old build wrote with `node scripts/republish.mts <folder>`, run `npm run db:migrate`, then `wrangler deploy --assets <folder>`.

Worker versions don't roll D1 back.

## Dropping `visits`

`worker/migrations/after-deploy/0003_drop_visits.sql` waits until no rollback to a Worker from before October 2026 is wanted; then `git mv` it into `worker/migrations/`, and the next deploy drops the table. Before that, those Workers' nightly prune deletes from `visits` and would fail without it.

## Search and sharing

- Each page's title, description and structured data are in `src/shell/pages.mts`; `src/shell/Head.tsx` makes the canonical URL, Open Graph and Twitter cards, and JSON-LD (`WebSite` on the home page, a `WebApplication` on each).
- `/map/`, `/dining/` and `/laundry/` render their header and description on the server, and laundry every room as a link, so crawlers see more than an empty `#app`. `src/shell/ui.tsx` renders on either side: `#jsx` resolves to bruh's browser or server JSX (`imports` in `package.json`).
- Laundry rooms (`/laundry/<room>/`) are the laundry page itself, canonical `/laundry/`, and not in the sitemap.
- Link previews are `public/social/<page>.png`, made by hand with `npm run social` since Workers Builds has no browser: Playwright screenshots the dev server (the map staged by `src/map/social.mts`), and `scripts/social.mts` lays out each 1200×630 card from the page's `label` and `shows` in `pages.mts`. Events' `/p/` pages share `public/social/pin.png` (`scripts/pin-image.mts`).
- A page's sitemap `lastmod` moves only when the page differs from the one served by more than its release.
- Google reads the sitemap named in `robots.txt`; Cloudflare's managed robots.txt prepends its content signals to `public/robots.txt`.

Set up once, by hand: the `notunh.app` domain property in Google Search Console (TXT record in Cloudflare DNS, then submit `https://notunh.app/sitemap.xml`), and Bing Webmaster Tools imported from it.
