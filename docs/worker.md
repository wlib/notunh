# The Worker

`worker/`: [Hono](https://hono.dev), Drizzle on D1. It runs only for `/api/*` and the laundry rooms' addresses (`run_worker_first` in `wrangler.jsonc`); everything else is served as static assets.

## Crons

Each invocation gets 10 ms of CPU and the account five cron triggers, so work is split across triggers and minutes. `worker/` matches the cron strings in `wrangler.jsonc` exactly, so change both together.

| Cron | Job |
|---|---|
| `* * * * *` | Buses: polls Umo's vehicles six times, 10 s apart (`worker/buses.mts`) |
| `*/5 * * * *` | Umo's predictions for routes with a bus out (`worker/predictions.mts`) |
| every minute but every fifth | Laundry: a quarter of the rooms each minute, so each room every 5 min (15 min from 1 to 6 AM) (`worker/laundry.mts`) |
| `17 8 * * *` (4:17 AM EDT) | Prune, then start the Observations and Inputs workflows, and Map data on Mondays ([deploying.md](deploying.md)) |

Bus samples are one gzipped row per source per minute polled, even when nothing was seen (`src/transit/observations/raw.mts`). Each row records every poll, failed ones included, so "no bus out" is distinguishable from "no answer". Requests to Umo and GitHub identify as `notunh/1 (+https://notunh.app)`.

Retention days are `vars` in `wrangler.jsonc`, explained in [storage.md](storage.md).

## API

`worker/api.mts`. Everything but health and laundry takes `Authorization: Bearer $BUILD_TOKEN`, else 401. Bodies are validated against Valibot schemas.

| Route | Auth | |
|---|---|---|
| `GET /api/health` | public | When each table's rows start and the last was stored, and the day each model runs through |
| `GET /api/rows/:name?day=…&after=…` | token | A page of rows from one table in `worker/rows.mts` |
| `GET /api/models/:name` | token | The latest `buses` or `laundry` model, with its revision |
| `POST /api/models/:name` `{ expect, state }` | token | Stores only if the latest revision is still `expect` (`null` for none), else 409 |
| `GET /api/feeds`, `GET /api/feeds/:id` | token | Timetables acquired, earliest first; one's converted JSON by SHA-256 |
| `POST /api/feeds` (form) | token | Acquires a timetable unless it's the one acquired last |
| `GET /api/derived/:name?day=…` | token | The manifest of a day's `visits`, `statistics`, or `evaluation`, or `null` |
| `PUT`/`GET /api/chunks/:generation/:part` | token | One part of a generation |
| `POST /api/derived/:name` `{ day, identity, generation, parts }` | token | Commits a generation once every part is stored, else 409 |
| `GET /api/storage` | token | D1's bytes and rows per table; counts every row, so on demand only |
| `GET /api/laundry/rooms[/:id]` | public | See [Laundry](#laundry) |
| `GET /api/push/key`, `PUT`/`DELETE /api/reminders/:id`, `DELETE /api/push/devices/:device` | public, each device's by its secret | See [reminders.md](reminders.md) |

Scripts call it through `scripts/worker.mts`, which also works by hand: `node --env-file=.dev.vars scripts/worker.mts health|storage|rows <name> [day]`, with `--local` for `npm run worker`.

Learning runs `main`'s code against the deployed Worker, so a route change meets the old Worker during a deploy. Make such changes ones the old Worker refuses (a missing route, a rejected body) rather than misreads; learning then stores nothing that night and the inputs carry the stored model.

## Reminders

Each device's reminders are a SQLite-backed Durable Object, `Reminders` (`worker/reminders.mts`), whose alarm
forecasts a run from the last minutes of `samples` with the site's own timetable and model, and pushes when its bus
is near. It's told the run and the stop, never where the trip goes. No cron is involved. See
[reminders.md](reminders.md).

## Schema changes

Edit `worker/schema.mts`, run `npm run db:generate`, and commit the migration in `worker/migrations/`.

Deploys apply migrations while the previous Worker still serves, so a migration must leave it working: add with defaults, and drop only what it no longer reads. A drop the previous Worker still needs waits in `worker/migrations/after-deploy/`, which wrangler doesn't read, until that Worker is gone for good ([deploying.md](deploying.md#dropping-visits)). `tests/worker/migrations.test.mts` applies the chain to the deployed schema with rows in it and checks it ends at `schema.mts`.

## Laundry

The rooms' Speed Queen machines report to LaundryConnect, which has no CORS, so pages ask the Worker. Vendor etiquette is a hard rule:

- The collector sends no User-Agent or other header of ours, and polls each room at most every 5 minutes.
- A room's live request forwards the asker's own User-Agent, never a synthesized one.
- Nothing else contacts the vendor.

Routes:

- `GET /api/laundry/rooms`: every room's free counts from D1 alone, edge-cached 5 minutes, so the room list never reaches the vendor. Counts over 30 minutes old say when they're from.
- `GET /api/laundry/rooms/:id`: the room live, edge-cached 30 s, falling back to the collector's last record (marked stale).
- `/laundry/<room>/`: the laundry page for each room in `src/laundry/rooms.json`; other `/laundry/…` paths 404. `vite.config.mts` routes the same in development.

The collector writes changes to `transitions` and `latest`, each poll to `polls`, and one snapshot per room to `room_snapshots`, all in epoch ms. D1 allows 100 bound parameters a statement and 50 queries a run, so a round writes at most 168 changes and leaves the rest for the next.

`src/laundry/infer.mts` decides what to claim per machine: a running machine's countdown is trusted while it reports, a quiet one past its end is probably done, and a finished one stays done until its door opens.

**Usual busyness.** Inputs runs `scripts/laundry/model.mts` nightly: it folds each whole day into `src/laundry/model.mts`'s statistics (4-week half-life, same fold as the bus model) and writes `src/laundry/usual.json`, the free count and chance of any free per room, machine kind, and hour of the week. Unwatched stretches are skipped, as are days a room did under 15 % of its usual business (breaks). Each hour leans on the room's all-hours average until it has six hours of watching.
