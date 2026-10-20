# The Worker

One Cloudflare Worker (`worker/`, [Hono](https://hono.dev), Drizzle on D1), on the free plan. It only runs for `/api/*` and the laundry rooms' addresses (`run_worker_first` in `wrangler.jsonc`); every other page and asset is served as a static asset, free and unmetered.

## Crons

The free plan allows five cron triggers per account and 10 ms of CPU per invocation. `worker/` matches the cron strings in `wrangler.jsonc` exactly, so change both together.

| Cron | Job |
|---|---|
| `* * * * *` | Buses: polls Umo's vehicles six times, 10 s apart (`worker/buses.mts`) |
| `*/5 * * * *` | Umo's predictions for routes with a bus out (`worker/predictions.mts`) |
| every minute but every fifth | Laundry: a quarter of the rooms each minute, so each room every 5 min, and every 15 min from 1 to 6 AM (`worker/laundry.mts`) |
| `17 8 * * *` (4:17 AM EDT) | Prune, dispatch the Observations workflow (and Map data on Mondays) given `GITHUB_TOKEN`, then POST the Deploy Hook so Cloudflare rebuilds with fresh menus, timetable, and models |

Bus samples are stored as one gzipped row per source per minute polled, even when nothing was seen (`src/transit/observations/raw.mts`). Each row names the normalization version it was packed by and records every poll it made, failed ones included, so a minute without a fix tells "no bus out" from "no answer". Requests to Umo and GitHub identify as `notunh/1 (+https://notunh.app)`.

Retention, in `wrangler.jsonc` `vars` and explained in [storage.md](storage.md): `RETAIN_ARCHIVED_DAYS` (14), `RETAIN_DAYS` (60), `RETAIN_VISIT_DAYS` (180), `RETAIN_SUMMARY_DAYS` (400).

## API

`worker/api.mts`:

| Route | Auth | |
|---|---|---|
| `GET /api/health` | public | When each table's rows start and the last was stored (in its own unit), and the day each model runs through. Cheap: two index lookups per table |
| `GET /api/rows/:name?day=YYYY-MM-DD&after=…` | token | A page of rows from one table in the registry (`worker/rows.mts`: `buses`, `predictions`, `visits`, `summaries`, `transitions`, `polls`, `machines`), by Durham day or service day |
| `POST /api/rows/:name` `{ rows, clear? }` | token | Writes the tables the build writes; `clear` replaces a whole day, transactionally |
| `GET /api/models/:name[?through=Day]` | token | The latest stored `buses`, `laundry`, their checkpoints `buses.training` and `laundry.training`, or the `gtfs` feed by version; with its revision and every day stored through |
| `POST /api/models/:name` `{ expect, state }` | token | Stores a new state only if the latest's revision is still `expect` (`null` for none), else 409 |
| `GET /api/storage` | token | D1's size in bytes and rows per table. Counts every row, so on demand only |
| `GET /api/laundry/rooms`, `GET /api/laundry/rooms/:id` | public | See Laundry below |

Token routes take `Authorization: Bearer $BUILD_TOKEN` and answer 401 without it. Request bodies are validated by `@hono/standard-validator` against `drizzle-valibot`'s schemas of the tables (`worker/schema.mts`). Build steps use `scripts/worker.mts`, which also works by hand: `BUILD_TOKEN=… node scripts/worker.mts health`, `storage`, or `rows <name> [day]`, with `--local` for `npm run worker`.

Each feed version is archived as of the day it was first seen; a second version first seen the same day is archived as of the next day, so neither replaces the other.

Schema changes: edit `worker/schema.mts`, run `npm run db:generate`, and commit the migration in `worker/migrations/`. Deploys apply migrations first (`predeploy`). Since the build learns against the *previous* Worker, a migration and the API using it must tolerate a build that runs before them.

## Laundry

The rooms' Speed Queen machines report to LaundryConnect (`laundryconnectlive.com`), which has no CORS, so pages ask the Worker. Vendor etiquette is a hard rule here:

- The collector's polls send no User-Agent or other header of ours, and poll each room at most every 5 minutes.
- An open room's live request forwards the asker's own User-Agent, never a synthesized one.
- Nothing else contacts the vendor.

Routes:
- `GET /api/laundry/rooms`: every room's free washers and dryers as the collector last saw them, from D1 alone, shared at the edge for 5 minutes. So the room list never reaches the vendor. Counts over half an hour old say when they're from.
- `GET /api/laundry/rooms/:id`: fetches the room live, shared at the edge for 30 s, falling back to the collector's last record (marked stale) when the vendor can't answer.
- `/laundry/<room>/`: the laundry page itself, for each room in `src/laundry/rooms.json`; any other `/laundry/…` path is a 404. The page moves between rooms with `history.pushState`, and `vite.config.mts` does the same routing in development.

The collector writes status changes to `transitions` and `latest`, each poll to `polls`, and one current snapshot per room to `room_snapshots`, all in epoch ms. D1 allows 100 bound parameters a statement and 50 queries a run on the free plan, so a round writes at most 168 changes and leaves the rest for the next.

`src/laundry/infer.mts` decides what to claim about each machine: a running machine's countdown is its own while it keeps reporting, a quiet one past its end is probably done, and a finished one sits done until its door opens.

**Usual busyness.** Each build (`scripts/laundry/model.mts`) folds every whole day since the last into `src/laundry/model.mts`'s statistics (same fold as the bus model, 4-week half-life) and writes `src/laundry/usual.json`: for every room, machine kind, and hour of the week, the time-weighted free count and chance of any free. Stretches nobody watched are left out, as are days a room did under 15 % of its usual business (breaks). Each hour leans on the room's all-hours average until it has six hours of watching; held out, that tied the average alone and beat the hours alone.
