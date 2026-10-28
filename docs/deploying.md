# Deploying

The site and API are one Cloudflare Worker (`wrangler.jsonc`) on Workers Paid, serving the built pages as static assets, with D1. Workers Builds builds `main` on every push and Deploy Hook POST, running `npm run build` then `npm run deploy`; keep the steps in `package.json`, never the dashboard.

## The pipeline

Each step makes one thing the next takes as made, pinned by version; what each keeps is in [storage.md](storage.md).

| Step | Runs | Makes |
|---|---|---|
| Collect | The Worker's crons | `samples` and laundry tables in D1 |
| Archive | `archive.yml`, nightly | `observations-<day>` releases and `catalog.json` |
| Map data | `map.yml`, Mondays | `map-data-<version>` releases and their pointer ([map.md](map.md)) |
| Inputs | `inputs.yml`, nightly | `inputs-<version>` releases and their pointer, then the Deploy Hook |
| Build | Workers Builds | The site and the Worker |

**Inputs** is the site's nightly clock, started by the Worker's 4:17 AM cron. It acquires the timetable, style, events, courses, menus, laundry rooms, parking areas and prerequisites (`node scripts/data.mts acquire`), runs the tests, learns the bus and laundry models through the Worker (`learn --store`), builds the site to check it, publishes, and POSTs the Deploy Hook.

- Upstream down: nothing is published, and the site keeps its inputs.
- One learner stalled: the other still runs; compatible previous or empty outputs may be published, then the run fails. A missing required model or asset blocks publication.
- Installation validates the whole bundle before clearing the old sources, so fixtures never fill production gaps.
- A rerun retries the Deploy Hook even if the pointer already moved.

**Releases.** A generation is published only if its pointer doesn't name it (`stage` in `scripts/release.mts`), so overlapping runs can't both publish, and is immutable once its manifest is up (`.github/actions/publish`); one left without is filled in again. Pointers (`latest.json`) and `catalog.json` go up last. The catalog is only merged into, so the Worker never prunes a day whose archive isn't whole, and each Archive run takes every settled day D1 has that the catalog lacks, oldest first, catching up after failures.

Nothing deletes releases. Old `inputs-*` and `map-data-*` ones may be deleted by hand once no build pins them and no old site will be rebuilt with its own.

## Build and deploy

1. `prebuild` installs the inputs and map data the pointers name (`scripts/inputs.mts`), keeps what's served now beside them for open tabs, and matches places. Typecheck and tests run in the pull request's Check and the nightly Inputs, not here. Needing no secrets and writing only its own folder, any branch's build is safe.
2. `vite build`, then `postbuild` (`scripts/search.mts`) writes the sitemap and IndexNow's key file.
3. `predeploy` applies D1 migrations (`npm run db:migrate`). A failed migration stops the deploy.
4. `wrangler deploy` ships the Worker and site together.
5. `postdeploy` (`scripts/indexnow.mts`) submits changed pages to IndexNow, on Workers Builds' deploys of `main` only.

`/inputs.json` names a site's inputs and map data.

## Workflows and secrets

| Workflow | When | Needs |
|---|---|---|
| Check (`check.yml`) | Pull requests: offline build and unit tests | Nothing (read-only token) |
| Inputs (`inputs.yml`) | Worker dispatch nightly, or by hand (`-f rebuild=true` to learn afresh) | `BUILD_TOKEN`, `CLOUDFLARE_DEPLOY_HOOK` |
| Observations (`archive.yml`) | 9:30 UTC nightly, Worker dispatch, or `-f from=<day> -f to=<day>` | `BUILD_TOKEN` |
| Map data (`map.yml`) | Mondays, Worker dispatch, or by hand | `CLOUDFLARE_DEPLOY_HOOK` (optional) |

`node scripts/secrets.mts check` says which secrets are set.

- **Worker**: `BUILD_TOKEN`; `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`, for reminders' pushes; and `GITHUB_TOKEN`, fine-grained with Actions read and write here, for the nightly cron to start Observations, Inputs, and Map data on Mondays. Inputs has no schedule of its own, as GitHub pauses schedules after 60 days without a commit. Without it the site keeps its last inputs, map data goes stale, and samples pile up in D1 till archiving resumes.
- **GitHub `production` environment** (`main` only): `BUILD_TOKEN`, and `CLOUDFLARE_DEPLOY_HOOK`, a Workers Builds deploy hook for `main`. Inputs and Map data record each run as a deployment of notunh.app.

`BUILD_TOKEN` is on both sides and in `.dev.vars`; change it only with `node scripts/secrets.mts rotate`, which sets all three. `node scripts/secrets.mts vapid` makes push keys where missing: the Worker's pair, never shown or replaced (a new pair cuts off every subscribed device), and another for `.dev.vars`.

**Email** needs no secret: codes go through Email Service's `send_email` binding once `notunh.app` is onboarded for sending ([social.md](social.md#sending-the-code)); till then, sending one answers 502.

## Rolling back

Clients never step back to an older release ([offline.md](offline.md)), so `wrangler rollback` reaches only new visitors. To go back for everyone, publish the old release again:

- rebuild its commit with the `NOTUNH_INPUTS` and `NOTUNH_MAP_DATA` its `/inputs.json` names, or
- stamp an old build's folder with `node scripts/republish.mts <folder>`, run `npm run db:migrate`, then `wrangler deploy --assets <folder>`.

Worker versions don't roll D1 back.

## Dropping `visits`

`worker/migrations/after-deploy/0003_drop_visits.sql` waits until no rollback to a Worker from before October 2026 is wanted; then `git mv` it into `worker/migrations/`, and the next deploy drops the table. Before that, those Workers' nightly prune deletes from `visits` and would fail without it.

## Search and sharing

[search.md](search.md) has the sitemap, bodies, structured data and the owner's checklist.

- Each page's title, description and trail are in `src/shell/pages.mts`; `src/shell/Head.tsx` makes the canonical URL, Open Graph and Twitter cards, and JSON-LD.
- `src/shell/ui.tsx` renders on either side: `#jsx` resolves to bruh's browser or server JSX (`imports` in `package.json`).
- Pages' link previews are `public/social/<page>.png`, made by hand with `npm run social` (no browser on Workers Builds): Playwright shoots the dev server (the map staged by `src/map/social.mts`), and `scripts/social.mts` lays out each 1200×630 card from `label` and `shows` in `pages.mts`.
- Shared pages preview as what they're of: `/p/<id>`, the map's (`/map/event/<id>`, `place/`, `section/` and the rest) and laundry rooms' (`worker/preview.mts`). From the data the map's head names (`worker/site.mts`, `src/map/site.mts`), the Worker heads it with a title, line (`src/social/preview.mts`), canonical address and card, `/map/card/<page>?v=<hash of its words>`, drawn by bundled Satori and resvg in Inter (`worker/card.mts`), edge-cached by URL; bump `LOOK` for a new look.
- Google reads the sitemap `robots.txt` names; Cloudflare prepends its content signals to `public/robots.txt`.
