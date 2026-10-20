# Buses: locating, forecasting, planning

How the map knows where each bus is, when it'll leave each stop, and how to get somewhere. All of it is in the domain layers (`src/transit/`, `src/routing/`), so nightly learning trains and replays with exactly the code the map runs.

## Inputs

- **Live**: the Umo IQ rider API (`api.prd-1.iq.live.umoiq.com/v2.0/riders/agencies/unh`). No key and open CORS, so browsers poll it directly: vehicles every 5 s, predictions every 30 s for routes with a bus out. It 403s once a URL passes about 1 KB, so stop lists are chunked. `src/transit/observations/umo.mts` is the only code that reads Umo's shape.
- **Timetable**: Wildcat Transit's GTFS feed on National RTAP, converted to `src/map/gtfs.json` nightly. Umo's trip and stop ids match it. Learning stores each newly acquired feed in the Worker (`/api/feeds`). A day is replayed against the timetable in effect then (`inEffect` in `scripts/map/replay.mts`): the last acquired by the day's end whose own dates don't exclude the day. Before any acquisition, it's the first whose dates name the day; with none, the day is folded in as unobserved. No effective date is ever made up.
- **History**: the Worker stores every minute of fixes and predictions, and Observations archives each day losslessly ([storage.md](storage.md)). These raw samples are the source of truth; visits and models are readings of them.

## The location model

`src/transit/inference/`. GPS puts a bus within a few meters, but only every 10 to 30 s, so what's uncertain is what it did between fixes.

1. **Matching** (`matching.mts`): an HMM matches each fix to a place along its route's shapes, weighed by distance off the street, heading (`likelihoods.mts`), and whether driving there from the previous place is plausible. Extraction runs Viterbi over the whole day. Live (`locate.mts`), each fix goes greedily to its likeliest place given the previous one.
2. **Between fixes** (`passages.mts`): the bus accelerates to a cruising speed, brakes, stops or not at each stop and dwells, or halts, for whatever time the gap leaves. This is integrated deterministically over a grid of cruising speeds and time splits. Where nothing fits the gap, a stop's time is anywhere between the surrounding fixes.
3. **Output**: each stop's arrival and departure as 10th/50th/90th percentiles, the chance the bus stopped, and how time was spent along the leg. A bus already at a stop when first seen, or still there when last seen, is flagged (`isJoined`, `isIncomplete`; `JOINED`, `INCOMPLETE` in extraction), and the model learns only the legs driven to or from it.

GPS likelihoods are fitted on Oct 7 to 19 fixes. They describe receivers and where buses stand, not traffic, so they don't drift with the timetable:

- Off-street error is half-normal, σ ≈ 2.5 m, except buses parked beside the route (about 3 % of fixes), σ ≈ 26 m.
- Heading error depends on speed; a standing bus has mostly lost its heading.
- Standing still comes from reported speed (0 km/h standing, 1 to 5 creeping).
- A bus at a stop stands a few meters past it.

There are no zones. The remaining hard cutoffs are bounds documented where they're set: distance off route, never backing up or exceeding 35 m/s, and creeping near a stop counting as at it. A particle filter was tried and measured too noisy.

## Movement

`src/transit/models/movement.mts`. From where the location model has the bus, at its current speed, settling toward the pace that reaches the next stop when expected:

- each leg as long as the model expects at that time of day, scaled by the bus's **pace**, a Kalman filter over how much longer its recent legs took, drifting back to usual over about an hour;
- time along a leg spent as buses' usually is;
- each stop as long as buses dwell there, or until the scheduled time where the trip waits for it.

Each followed bus's course is built once along its trip. Forecasts and the drawn bus use the same course, so the drawn bus is at each stop from its forecast arrival to departure (`tests/transit/forecast.test.mts`, `tests/map/buses.test.mts`). A bus on no known trip is drawn along its line. `tracking.mts` follows a bus fix by fix, as the map does live and scoring replays.

Resetting pace after a break, per-time-of-day pace per bus, and a mixture model for held-up legs measured no better than one bounded spread.

## Forecasting departures

`src/transit/models/forecast.mts` produces every departure shown.

- **A followed bus** is forecast along its course; how much longer it stays at a stop depends on how long it's been there. Where its trip ends at the start of a later trip of its route, it continues through a layover into the trip due nearest when it could start (or Umo's next), within 30 min after or 60 min before. That continuation is expected, not live, until seen. Of two buses on one trip, the one nearer its time runs it.
- **Timetabled routes** (3 and 4, which mark timepoints) are forecast from the timetable shifted by how late the route runs, from 30 min ahead on. Runs with no bus followed are shifted likewise.
- **Headway routes** with no bus followed show how often buses come and how soon the next likely does, rather than timetable times.
- **Umo's predictions** assign buses to trips and cancel runs, and set times only for a bus or route the model can't follow. Umo's schedule-based start guesses are ignored.

A run's times aren't forced into order. The planner's connections never go back in time (`buildConnections`), which a property test checks.

Held out a day at a time on Oct 7 to 19, the median error of a followed bus's departures went from 60, 126, and 202 s to 28, 50, and 75 s at 1, 5, and 10 minutes ahead.

## The learned model

Inputs fits `src/map/model.json` nightly (`scripts/map/model.mts`). For each completed service day, three things are derived and stored in the Worker (`worker/derived.mts`), each keyed by exactly what it came from:

1. **Visits**: each bus's stop visits (`src/transit/inference/events.mts`), from the observations' id, the timetable's, and `EXTRACTOR`.
2. **Statistics**: what the visits show (`summarize` in `src/transit/models/fit.mts`), plus the model's shape `version`.
3. **Evaluation**: how the model before that day forecast it, plus the `PREDICTOR` and the model's hash.

Statistics fold into decayed sums with a 4-week half-life (`src/shared/learn.mts`), so a new semester takes over within a month. Evaluations fold into scores only while the predictor is unchanged; a new predictor starts the scores afresh.

Keyed by stop and route ids (which last across timetables, unlike trip ids), the model keeps:

- each leg's time by route, weekday/weekend, and two-hour slot, whether driven or lost to GPS;
- how a leg's time is spent along it;
- dwell at each stop and layover at trip starts, and how much longer a bus already there a while still stays;
- whether early buses wait for their scheduled time;
- each route's lateness and hourly headways, counted only where the Worker's polls show it was listening.

Sparse estimates lean on broader ones (`src/transit/models/estimates.mts`). An empty model has none, and the map falls back on built-in constants. Learning bounds (a leg over 10 min, a stop over 15 min) are documented in `fit.mts`.

**Scoring.** Each day is replayed (`scripts/map/replay.mts`) at 1, 3, 5, 10, 20, 30, and 60 minutes before each departure, using the fixes the map would have seen in poll order, against Umo's prediction and the timetable. Moments the Worker wasn't listening aren't scored. How many standard deviations the model was off sizes the planner's slack. Bump `FORECAST` (`forecast.mts`) with any forecasting change and `REPLAY` (`replay.mts`) with any scoring change.

**Versions.** The model's shape `version` is 3. A stored model of another version is refit from the first day observed.

**Learning.** `scripts/learn.mts` continues from the model D1 stores, folds in each whole day since, and stores the result compare-and-swap. A day it can't read stops it there; the next night carries on. A rebuild (`gh workflow run inputs.yml -f rebuild=true`, or `npm run model -- --store --rebuild`) runs to the end in one job, reusing matching derived data, and isn't stored if cut short. A model of a new version is stored however far it gets.

## Trip planning

`src/routing/plan.mts`: the [Connection Scan Algorithm](https://arxiv.org/abs/1703.05997) over the day's forecast runs, plus a reverse scan so each option leaves as late as possible.

- Each connection carries its uncertainty: the chain's spread scaled to observed forecast error at that lead, or the route's lateness variance.
- Umo is seen only as observations. A trip due at a stop within Umo's predicted range that Umo doesn't mention is dropped. Predictions older than three polls are dropped.
- Each stop time's pickup and drop-off rules ("Arrivals Only") are honored.
- How early to be at a stop weighs the learned chance the bus waits for its scheduled time.
- Walks come from `src/routing/walks.mts` ([map.md](map.md)); an estimated walk gets more slack.
- Itineraries persist across replans only while they'd show the same; the chosen one is remembered by key.
