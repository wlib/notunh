# Deploying

The site and API are one Cloudflare Worker (`wrangler.jsonc`) serving the built pages as static assets, with D1 as its database. Cloudflare Workers Builds builds `main` on every push and whenever a workflow POSTs the Deploy Hook. Its build command is `npm run build` and its deploy command `npm run deploy`; keep the steps in `package.json` so the dashboard never needs editing.

## The pipeline

Each step makes one thing and the next takes it as made, pinned by version. What each makes and keeps is in [storage.md](storage.md).

| Step | Runs | Makes |
|---|---|---|
| Collect | The Worker's crons | `samples` and laundry tables in D1 |
| Archive | `archive.yml`, nightly | `observations-<day>` releases and `catalog.json` |
| Map data | `map.yml`, Mondays | `map-data-<version>` releases and their pointer ([map.md](map.md)) |
| Inputs | `inputs.yml`, nightly | `inputs-<version>` releases and their pointer, then the Deploy Hook |
| Build | Workers Builds | The site and the Worker |

**Inputs** is the site's nightly clock. The Worker's 4:17 AM cron starts it. It acquires the timetable, style, menus, and laundry rooms (`node scripts/data.mts acquire`), runs the tests, learns the bus and laundry models through the Worker (`learn --store`), builds the site to check it all, publishes the release, and POSTs the Deploy Hook.

- If upstream is down, nothing is published and the site keeps its inputs.
- If one learner stalls, both are still attempted. Compatible previous or empty outputs can still be published, and the run reports the stall afterward. A required model or asset missing blocks publication.
- Installation validates the whole bundle before clearing the old generated sources, so fixtures never fill gaps in production inputs.
- Rerunning a publication retries the Deploy Hook even if the pointer already moved.

**Releases.** Inputs and Map data publish a generation only when the pointer doesn't already name it (`stage` in `scripts/release.mts`), so overlapping runs can't double-publish. A generation is immutable once its manifest is up (`.github/actions/publish`); a release left without one is filled in again. Pointers (`latest.json`) and the observations `catalog.json` are uploaded last. The catalog is only merged into, never rebuilt, so the Worker never prunes a day whose archive isn't whole. Observations archives every settled day D1 has that the catalog lacks, oldest first, so failed nights catch up on their own.

Nothing deletes releases. Old `inputs-*` and `map-data-*` releases are safe to delete by hand once no build pins them, unless you want to rebuild an old site with its own inputs.

## Build and deploy

1. `prebuild` installs the inputs and map data the pointers name (`scripts/inputs.mts`), keeps what the site serves now beside them for open tabs, matches places, and runs the typecheck and tests. It needs no secrets and writes only its own folder, so any branch's build is safe.
2. `vite build`, then `postbuild` (`scripts/search.mts`) adds social images, the sitemap, and IndexNow's key file.
3. `predeploy` applies D1 migrations. A failed migration stops the deploy.
4. `wrangler deploy` ships the Worker and site together.
5. `postdeploy` (`scripts/indexnow.mts`) submits changed pages to IndexNow, only on Workers Builds' deploys of `main`.

`/inputs.json` on the site names the inputs and map data it was built from. Migrations run while the previous Worker still serves; see [worker.md](worker.md#schema-changes) for what that requires.

## Workflows and secrets

| Workflow | When | Needs |
|---|---|---|
| Check (`check.yml`) | Pull requests: offline build, unit and browser tests | Nothing (read-only token) |
| Inputs (`inputs.yml`) | Worker dispatch nightly, or by hand (`-f rebuild=true` to learn afresh) | `BUILD_TOKEN`, `CLOUDFLARE_DEPLOY_HOOK` |
| Observations (`archive.yml`) | 9:30 UTC nightly, Worker dispatch, or `-f from=<day> -f to=<day>` | `BUILD_TOKEN` |
| Map data (`map.yml`) | Mondays, Worker dispatch, or by hand | `CLOUDFLARE_DEPLOY_HOOK` (optional) |

Secrets live in two places. `node scripts/secrets.mts check` says whether each is set.

- **Worker**: `BUILD_TOKEN`, and `GITHUB_TOKEN`, a fine-grained token with Actions read and write on this repository. The nightly cron uses it to start Observations and Inputs, and Map data on Mondays. Inputs has no schedule of its own, because GitHub pauses schedules after 60 days without a commit. Without `GITHUB_TOKEN` the site keeps its last inputs, map data stops refreshing, and samples pile up in D1 until archiving resumes.
- **GitHub `production` environment** (only `main` can use it): `BUILD_TOKEN`, and `CLOUDFLARE_DEPLOY_HOOK`, the URL of a Workers Builds deploy hook for `main`. Inputs and Map data record each run as a deployment of notunh.app.

`BUILD_TOKEN` is on both sides and in `.dev.vars`, so change it only with `node scripts/secrets.mts rotate`, which sets all three.

## Rolling back

Clients never step back to a release older than the one they have ([offline.md](offline.md)), so `wrangler rollback` only reaches new visitors. To go back for everyone, publish the old release again:

- rebuild its commit with the `NOTUNH_INPUTS` and `NOTUNH_MAP_DATA` its `/inputs.json` names, or
- stamp a folder an old build wrote with `node scripts/republish.mts <folder>`, run `npm run db:migrate`, then `wrangler deploy --assets <folder>`. Worker versions don't roll D1 back.

## Dropping `visits`

`worker/migrations/after-deploy/0003_drop_visits.sql` waits there until no rollback to a Worker from before October 2026 is wanted. Then `git mv` it into `worker/migrations/` and push; the next deploy drops the table. Not before: those Workers delete from `visits` in their nightly prune, which would fail every night without it.

## Search and sharing

- Each page's title, description, and structured data are in `src/shell/pages.mts`. `src/shell/Head.tsx` turns them into the canonical URL, Open Graph and Twitter cards, and JSON-LD (`WebSite` on the home page, a `WebApplication` on each).
- `/map/`, `/dining/`, and `/laundry/` render their header and description on the server, and laundry every room as a link, so crawlers see more than an empty `#app`. `src/shell/ui.tsx` renders on either side: `#jsx` resolves to bruh's browser or server JSX by build conditions (`imports` in `package.json`).
- Laundry rooms (`/laundry/<room>/`) are the laundry page itself, so their canonical URL is `/laundry/` and they're not in the sitemap.
- Link previews are `public/social/<page>.png`, made by hand with `npm run social` since Workers Builds has no browser. Playwright screenshots the dev server (the map staged by `src/map/social.mts`), and `scripts/social.mts` lays out each 1200×630 card. The card's words are the page's `label` in `pages.mts`, its alt text the page's `shows`.
- A page's sitemap `lastmod` moves only when the page differs from the one served by more than its release.
- After a deploy, changed pages go to IndexNow. Google reads the sitemap named in `robots.txt`. Cloudflare's managed robots.txt prepends its content signals to `public/robots.txt`.

Set up once, by hand: the `notunh.app` domain property in Google Search Console (TXT record in Cloudflare DNS, then submit `https://notunh.app/sitemap.xml`), and Bing Webmaster Tools imported from Search Console.
