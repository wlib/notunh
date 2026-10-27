# The Worker

`worker/`: [Hono](https://hono.dev), Drizzle on D1. It runs only for `/api/*`, laundry rooms' addresses, `/p/<id>`, the map's pages, `/map/<kind>/…`, and their cards (`run_worker_first` in `wrangler.jsonc`); the rest is static.

## Crons

`worker/` matches the cron strings in `wrangler.jsonc` exactly, so change both together. Each job is split to stay small per invocation.

| Cron | Job |
|---|---|
| `* * * * *` | Buses: polls Umo's vehicles six times, 10 s apart (`worker/buses.mts`) |
| `*/5 * * * *` | Umo's predictions for routes with a bus out (`worker/predictions.mts`) |
| every minute but every fifth | Laundry: a quarter of the rooms each minute, so each room every 5 min (15 min from 1 to 6 AM) (`worker/laundry.mts`) |
| `17 8 * * *` (4:17 AM EDT) | Prune, then start Observations and Inputs, and Map data on Mondays ([deploying.md](deploying.md)) |

Bus samples are one gzipped row per source per minute polled (`src/transit/observations/raw.mts`), failed polls and empty ones included, so "no bus out" differs from "no answer". Requests to Umo and GitHub say `notunh/1 (+https://notunh.app)`. Retention days are `vars` in `wrangler.jsonc` ([storage.md](storage.md)).

## API

`worker/api.mts`, with the social routes in `worker/social.mts`. Bodies are Valibot-checked. Private routes take `Authorization: Bearer $BUILD_TOKEN`, else 401. A device's routes take its secret as a bearer token, or its `notunh-device` cookie (`worker/session.mts`).

| Route | Auth | |
|---|---|---|
| `GET /api/health` | public | When each table's rows start and the last was stored, and the day each model runs through |
| `GET /api/rows/:name?day=…&after=…` | token | A page of rows from one table in `worker/rows.mts` |
| `GET /api/models/:name` | token | The latest `buses` or `laundry` model, with its revision |
| `POST /api/models/:name` `{ expect, state }` | token | Stores only if the latest revision is still `expect` (`null` for none), else 409 |
| `GET /api/feeds`, `GET /api/feeds/:id` | token | Timetables acquired, earliest first; one's converted JSON by SHA-256 |
| `POST /api/feeds` (form) | token | Acquires a timetable unless it's the last one acquired |
| `GET /api/derived/:name?day=…` | token | The manifest of a day's `visits`, `statistics`, or `evaluation`, or `null` |
| `PUT`/`GET /api/chunks/:generation/:part` | token | One part of a generation |
| `POST /api/derived/:name` `{ day, identity, generation, parts }` | token | Commits a generation once every part is stored, else 409 |
| `GET /api/storage` | token | D1's bytes and rows per table, counted on demand |
| `GET /api/laundry/rooms[/:id]` | public | [Laundry](#laundry) |
| `GET /api/push/key`, `PUT`/`DELETE /api/reminders/:id`, `DELETE /api/push/devices/:device` | device | [reminders.md](reminders.md#routes) |
| `GET /api/pins?day=…`, `/api/pins/:id`, `/p/:id`, `/map/<page>`, `/map/card/<page>` | public; says more to the device asking as itself | The day's public pins, one, and a shared page headed with what it's of, and its card ([deploying.md](deploying.md#search-and-sharing)) |
| `POST /api/pins`, `POST /api/pins/:id/{marks,set,going,reports}`, `DELETE /api/pins/:id` | device | Make, mark a time, set the time (host), go, report, delete (host) |
| `POST /api/link`, `GET`/`POST /api/link/:code` | device | A code to link devices, its standing, its approval |
| `POST /api/email`, `POST /api/email/verify` | device | A code emailed to a UNH address, and its check, which may join the device to the address's person |
| `GET /api/me` | device | Who the device is |
| `POST /api/state` `{ device, entries }` | device | Your things written since last asked; answers all kept for the person ([storage.md](storage.md#your-things-kept-for-you)) |
| `GET /api/session` | cookie | The device's id and secret, for a browser whose storage lost them; 401 without |

Scripts use `scripts/worker.mts`: `node --env-file=.dev.vars scripts/worker.mts health|storage|rows <name> [day]`, `--local` for `npm run worker`.

**Locally**, `npm run worker` simulates Email Service: a code is logged ("send_email binding called"), its text written under `.wrangler/tmp/`, and nothing sent. A local D1 from before `0004_social` (a `votes` table, no `devices.push`) fails social commands; `wrangler d1 migrations apply notunh --local --persist-to <folder>` and `wrangler dev --persist-to <folder>` start one afresh.

Learning runs `main`'s code against the deployed Worker, so a route change meets the old Worker during a deploy: make it one the old Worker refuses (a missing route, a rejected body) rather than misreads, so learning stores nothing that night and the inputs carry the stored model.

## Reminders

Each device's reminders are a SQLite-backed Durable Object, `Reminders` (`worker/reminders.mts`), whose alarm forecasts a run from recent `samples` with the site's own timetable and model, and pushes when its bus is near. It's told a time, a lead, and the run and stop, never where the trip goes ([reminders.md](reminders.md)).

## Schema changes

Edit `worker/schema.mts`, run `npm run db:generate`, commit the migration in `worker/migrations/`.

Deploys apply migrations while the previous Worker still serves, so a migration must leave it working: add with defaults, and drop only what it no longer reads. A drop the previous Worker still needs waits in `worker/migrations/after-deploy/`, which wrangler doesn't read ([deploying.md](deploying.md#dropping-visits)). `tests/worker/migrations.test.mts` applies the chain to the deployed schema with rows in it and checks it ends at `schema.mts`.

## Laundry

The rooms' Speed Queen machines report to LaundryConnect (`laundryconnectlive.com`), which has no CORS, so pages ask the Worker. Vendor etiquette is a hard rule:

- The collector sends no header of ours, User-Agent included, and polls each room at most every 5 minutes.
- A room's live request forwards the asker's own User-Agent, never a synthesized one.
- Nothing else contacts the vendor.

Routes:

- `GET /api/laundry/rooms`: every room's free counts from D1 alone, edge-cached 5 minutes, so the list never reaches the vendor. Counts over 30 minutes old say when they're from. A map place page asks it once, for its halls' machines.
- `GET /api/laundry/rooms/:id`: the room live, edge-cached 30 s, falling back to the collector's last record (marked stale).
- `/laundry/<room>/`: the laundry page for each room in `src/laundry/rooms.json`; other `/laundry/…` paths 404. `vite.config.mts` routes the same in development.

The collector writes changes to `transitions` and `latest`, each poll to `polls`, and a snapshot per room to `room_snapshots`, in epoch ms. D1 allows 100 bound parameters a statement and 50 queries a run, so a round writes at most 168 changes, leaving the rest for the next.

`src/laundry/infer.mts` decides what to claim per machine: a running machine's countdown is trusted while it reports, a quiet one past its end is probably done, and a finished one stays done until its door opens.

**Usual busyness.** Inputs runs `scripts/laundry/model.mts` nightly, folding each whole day into `src/laundry/model.mts`'s statistics (4-week half-life, as the bus model) and writing `src/laundry/usual.json`: the free count and chance of any free per room, machine kind, and hour of the week. Unwatched stretches are skipped, as are days a room did under 15 % of its usual business (breaks); each hour leans on the room's all-hours average until six hours are watched.
