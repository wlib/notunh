# Buses: locating, forecasting, planning

How the map knows where each bus is, when it'll leave each stop, and how to get somewhere. All of it is in the domain layers (`src/transit/`, `src/routing/`), so nightly learning trains and replays exactly the code the map runs.

## Inputs

- **Live**: the Umo IQ rider API (`api.prd-1.iq.live.umoiq.com/v2.0/riders/agencies/unh`), with no key and open CORS, so browsers poll it directly: vehicles every 5 s, predictions every 30 s for routes with a bus out. It 403s past about 1 KB of URL, so stop lists are chunked. Only `src/transit/observations/umo.mts` reads Umo's shape.
- **Timetable**: Wildcat Transit's GTFS on National RTAP, converted nightly to `src/map/gtfs.json`, with each trip's block (the trips one bus runs in a day). Umo's trip and stop ids match it. Learning stores each newly acquired feed in the Worker (`/api/feeds`). A day replays against the timetable in effect then (`inEffect` in `scripts/map/replay.mts`): the last acquired by the day's end whose dates don't exclude it; before any acquisition, the first whose dates name the day; with none, the day is unobserved. No effective date is made up.
- **History**: the Worker stores every minute of fixes and predictions, and Observations archives each day losslessly ([storage.md](storage.md)). These samples are the source of truth; visits and models are readings of them.

## The location model

`src/transit/inference/`. GPS puts a bus within a few meters, but only every 10 to 30 s, so what's uncertain is what it did between fixes.

1. **Matching** (`matching.mts`): an HMM matches each fix to a place along its route's shapes, weighed by distance off the street, heading (`likelihoods.mts`), and whether driving there from the previous place is plausible. Extraction runs Viterbi over the day; live (`locate.mts`), each fix goes greedily to its likeliest place given the last.
2. **Between fixes** (`passages.mts`): the bus accelerates to a cruising speed, brakes, stops or not at each stop and dwells, or halts, for whatever time the gap leaves, integrated deterministically over a grid of cruising speeds and time splits. Where nothing fits, a stop's time is anywhere between the fixes.
3. **Output**: each stop's arrival and departure as 10th/50th/90th percentiles, the chance the bus stopped, and how time was spent along the leg. A bus already at a stop when first seen, or still there when last seen, is flagged (`isJoined`, `isIncomplete`), and only the legs driven to or from it are learned.

GPS likelihoods are fitted on Oct 7 to 19 fixes; they describe receivers and where buses stand, not traffic, so they don't drift with the timetable:

- Off-street error is half-normal, σ ≈ 2.5 m, except buses parked beside the route (about 3 % of fixes), σ ≈ 26 m.
- Heading error depends on speed; a standing bus has mostly lost its heading.
- Standing comes from reported speed (0 km/h standing, 1 to 5 creeping).
- A bus at a stop stands a few meters past it.

There are no zones. The remaining hard cutoffs are bounds documented where set: distance off route, never backing up or exceeding 35 m/s, and creeping near a stop counting as at it. A particle filter measured too noisy.

## Movement

`src/transit/models/movement.mts`. From where the location model has the bus, at its current speed, settling toward the pace that reaches the next stop when expected:

- each leg as long as the model expects at that time of day, scaled by the bus's **pace**, a Kalman filter over how much longer its recent legs took, drifting back to usual over about an hour;
- time along a leg spent as buses' usually is;
- each stop as long as buses dwell there, or until the scheduled time where the trip waits;
- a bus halted between stops, by the location model or a reported speed under `SLOW` (1.4 m/s), held for what's left of a halt (lognormal, median 24.5 s) before driving on, counted from the first slow fix (`slowSince` in `tracking.mts`). GPS reports 2 to 4 km/h from a bus standing in traffic, which reads as moving: on Oct 15, 824 of the 1,310 fixes the course had got over 50 m ahead of were such buses. Held, the course is ahead at 18 % of fixes rather than 25 %, by 121 m at the 99th percentile rather than 162, and behind as before. A bus slow just out of a stop is held too: of Oct 15's slow fixes within 10 s of leaving one, a third had moved on by the next fix, against a seventh of the rest.

Each followed bus's course is built once along its trip. Forecasts and the drawn bus share it, so the drawn bus is at each stop from its forecast arrival to departure (`tests/transit/forecast.test.mts`, `tests/map/buses.test.mts`). A bus on no known trip is drawn along its line. `tracking.mts` follows a bus fix by fix, as the map does live and scoring replays.

**What the map draws** (`src/map/render/buses.mts`): each bus at the model's estimate of now, its course timed from its last fix by our clock, at most 45 s past it. A new fix or course moves the model's bus, and the drawn one follows (`smoothed`) rather than jumping: at the model's speed plus the gap over 4 s, never backwards, never under half the model's speed while ahead, never over 12 m/s faster while behind. It jumps only for a bus first drawn, on another line, hidden over 5 s, or 300 m off. Measured on Oct 15: the drawn bus is over 20 m from the model 370 s a bus-hour (192 for waiting on the model), closes at 10 m/s over the model's speed at the 90th percentile (29), and never stands while the model drives. Nothing learned comes from where a bus was drawn.

Resetting pace after a break, per-time-of-day pace per bus, and a mixture model for held-up legs measured no better than one bounded spread.

## Forecasting departures

`src/transit/models/forecast.mts` produces every departure shown.

- **A followed bus** is forecast along its course; how much longer it stays at a stop depends on how long it's been there. Where its trip ends at a later trip's start, it continues through a layover into the next trip of its GTFS block, else the trip due to start there soonest after its own is due to end, by timetable, not clock (so a late bus goes on into the trip it's late for), within 30 min; Umo's word on its next trip comes first. It chains on while that foretells better than the timetable, about 70 min on the headway routes, as expected rather than live until seen. Of two buses on one trip, the one nearer its time runs it. A bus of a timetabled route tagged with a trip it's over 15 min ahead of is on its way to the start, or on an earlier slot: it's chained to the end and around to the stops before it.
- **Timetabled routes** (3 and 4, which mark timepoints) are forecast from the timetable shifted by how late the route runs, from 30 min ahead on, as are runs with no bus followed and headway routes beyond 70 min.
- **Headway routes** with no bus followed show how often buses come and how soon the next likely does.
- **Umo's predictions** assign buses to trips and cancel runs, and set times only for a bus or route the model can't follow. Umo's schedule-based start guesses are ignored.

**Bands** (`spreadTo`): how far off a departure may be, which the planner's slack and the reminders' lead allow for. A followed bus's is its chain's spread scaled by how far off forecasts have turned out at that lead (`bandScale`), never under the 30 s a boarding takes and unclipped (a 240 s clip cut 91 % of bands 30 min ahead on Oct 15, catching 81 % of buses for 85 % asked). A stop handed off to the timetable (`tracked.variances[i]` undefined) gets the timetable's band whole, the route's lateness variance, as a run with no bus followed. With nothing learned, a fixed spread grows with the lead, capped at 240 s and doubled from the timetable alone.

A run's times aren't forced into order; the planner's connections never go back in time (`buildConnections`), which a property test checks.

Held out a day at a time on Oct 7 to 19, a followed bus's median departure error is 28, 50 and 75 s at 1, 5 and 10 minutes ahead. Replayed on Oct 8 to 19, the mean error of every departure shown is below the timetable's and Umo's at every lead: 86, 148, 204, 269, 363 and 435 s at 1, 5, 10, 20, 30 and 60 minutes, against the timetable's 505 s and Umo's 117, 189, 271, 364, 419 and 394 s on the departures it predicted.

## The learned model

Inputs fits `src/map/model.json` nightly (`scripts/map/model.mts`). For each completed service day, three things are derived and stored in the Worker (`worker/derived.mts`), each keyed by exactly what it came from:

1. **Visits**: each bus's stop visits (`src/transit/inference/events.mts`), from the observations' id, the timetable's, and `EXTRACTOR`.
2. **Statistics**: what the visits show (`summarize` in `src/transit/models/fit.mts`), plus the model's shape `version`.
3. **Evaluation**: how the model before that day forecast it, plus `PREDICTOR` and the model's hash.

Statistics fold into decayed sums with a 4-week half-life (`src/shared/learn.mts`), so a new semester takes over within a month. Evaluations fold into scores only while the predictor is unchanged.

Keyed by stop and route ids (which last across timetables, unlike trip ids), the model keeps:

- each leg's time by route, weekday/weekend, and two-hour slot, driven or lost to GPS;
- how a leg's time is spent along it;
- dwell at each stop and layover at trip starts, and how much longer a bus already there a while stays;
- whether early buses wait for their scheduled time;
- each route's lateness and hourly headways, counted only where the Worker's polls show it was listening.

Sparse estimates lean on broader ones (`src/transit/models/estimates.mts`). An empty model falls back on built-in constants. Learning bounds (a leg over 10 min, a stop over 15 min) are in `fit.mts`.

**Scoring.** Each day is replayed (`scripts/map/replay.mts`) every 5-minute sample from a minute to just over an hour before each departure, with the fixes the map would have seen in poll order and Umo's word as sampled once the sample was all in (`received` on a `PredictionSample`, from `RAW_VERSION` 2, so from Oct 20). Each forecast is scored once, at the nearest of 1, 3, 5, 10, 20, 30 and 60 minutes. Columns:

- `model`: what the map would have shown (a chain or the shifted timetable), by lead, on the same departures as `schedule`, less the few Umo had as not coming;
- `tracked`: the chain alone where it foretells the stop, by its predicted lead, as the map and Worker ask for its band; the band-calibrating ratios are binned so, leaving out forecasts with the bus already past the stop;
- `umo`: Umo's prediction sampled then.

Moments the Worker wasn't listening aren't scored. Bump `FORECAST` (`forecast.mts`) with any forecasting change and `REPLAY` (`replay.mts`) with any scoring change. On Oct 19 (`FORECAST` 3) the model's mean error was 110, 135, 162, 209, 262, 355 and 440 s at 1, 3, 5, 10, 20, 30 and 60 minutes; by predicted lead, the chain alone (`REPLAY` 4) is 544, 92, 116, 157, 192, 262 and 293 s.

The 1-minute chain figure isn't buses lingering: of Oct 19's 861 chain forecasts in that bin, 196 had the bus already past the stop (a median 6 to 14 min early) while it really left 10 to 60 min later, carrying 83 % of the bin's error with a chain sd of 11 s: confident misses at mid-trip stops, mostly on the Gables loop. Scored into the ratios, they'd put the 1-minute band scale at 2.03; left out, it's 1.27. **Open:** how a followed bus on a loop gets placed 10 to 60 minutes ahead of itself (`placed` in `forecast.mts` takes the scheduled visit nearest in time, and a loop visits a stop twice); the reviewer's `rv-tail.mts` lists the stops. Until it's fixed, the Worker calls a bus gone only once its scheduled time has gone too ([reminders.md](reminders.md)).

**Versions.** The model's shape `version` is 4; a stored model of another version is refit from the first day observed.

**Learning.** `scripts/learn.mts` continues from the model D1 stores, folds in each whole day since, and stores the result compare-and-swap. A day it can't read stops it there; the next night carries on. A rebuild (`gh workflow run inputs.yml -f rebuild=true`, or `npm run model -- --store --rebuild`) runs to the end in one job, reusing matching derived data, and isn't stored if cut short; a model of a new version is stored however far it gets.

## Trip planning

`src/routing/plan.mts`: the [Connection Scan Algorithm](https://arxiv.org/abs/1703.05997) over the day's forecast runs, plus a reverse scan so each option leaves as late as possible.

- Each connection carries its uncertainty: the chain's spread scaled to observed error at that lead, or the route's lateness variance.
- Umo is seen only as observations. A trip due at a stop within Umo's predicted range that Umo doesn't mention is dropped, as are predictions older than three polls.
- Pickup and drop-off rules ("Arrivals Only") are honored.
- How early to be at a stop weighs the learned chance the bus waits for its scheduled time.
- Walks come from `src/routing/walks.mts` ([map.md](map.md)); an estimated walk gets more slack.
- Itineraries persist across replans only while they'd show the same; the chosen one is remembered by key.
- **Arrive by** (`planBy`): the latest-leaving ways that get there by a time, stepping through each first bus until one is due too late, and a minute at a time past a start walking would beat any bus from. Its connections reach to the time asked, however far ahead (a trip saved for tomorrow morning, opened tonight, is 13 hours out; 20 to 35 ms on the bundled timetable), not only `HORIZON`'s four hours. The earliest arrival never gets earlier for a later start, so the latest start that makes it is exact. Each way must beat walking by `MIN_TIME_SAVED` (`betterThanWalking`), with time there before the time asked costed on its own (`EARLY_THERE`), so a bus that gets a 300 m walk there 20 minutes early isn't offered and the evening's last bus for a 9 PM goal is. When nothing makes it, the map shows the ways leaving now, soonest first, and says so. Walking the whole way is offered to arrive at the time, its allowance kept (`walkBy`).
