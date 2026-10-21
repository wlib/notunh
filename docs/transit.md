# Buses: locating, forecasting, planning

How the map knows where each bus is, when it'll leave each stop, and how to get somewhere. All of it is in the domain layers (`src/transit/`, `src/routing/`), so nightly learning trains and replays with exactly the code the map runs.

## Inputs

- **Live**: the Umo IQ rider API (`api.prd-1.iq.live.umoiq.com/v2.0/riders/agencies/unh`). No key and open CORS, so browsers poll it directly: vehicles every 5 s, predictions every 30 s for routes with a bus out. It 403s once a URL passes about 1 KB, so stop lists are chunked. `src/transit/observations/umo.mts` is the only code that reads Umo's shape.
- **Timetable**: Wildcat Transit's GTFS feed on National RTAP, converted to `src/map/gtfs.json` nightly, with each trip's block, the trips one bus runs in a day. Umo's trip and stop ids match it. Learning stores each newly acquired feed in the Worker (`/api/feeds`). A day is replayed against the timetable in effect then (`inEffect` in `scripts/map/replay.mts`): the last acquired by the day's end whose own dates don't exclude the day. Before any acquisition, it's the first whose dates name the day; with none, the day is folded in as unobserved. No effective date is ever made up.
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
- each stop as long as buses dwell there, or until the scheduled time where the trip waits for it;
- a bus halted between stops, by the location model's reading or by a reported speed under `SLOW` (1.4 m/s, 5 km/h), held where it is for what's left of a halt (a lognormal with median 24.5 s) before it drives on, counted from the first fix that had it slow (`slowSince`, remembered per bus in `tracking.mts`), not afresh at each. GPS reports a residual 2 to 4 km/h from a bus standing in traffic, which the locator reads as moving: on Oct 15, 824 of the 1,310 fixes the course had got more than 50 m ahead of were such buses. Held, the course is ahead at 18 % of fixes rather than 25 %, by 121 m at the 99th percentile rather than 162, and behind as before. A bus reported slow just out of a stop is held too: of Oct 15's slow fixes within 10 s of leaving one, a third had moved on by the next fix, against a seventh of the rest, so most are standing. Slow spells are short (a median 15 s, one fix), so the memory changes little: 81 s a bus-hour held while the bus moved, against 83.

Each followed bus's course is built once along its trip. Forecasts and the drawn bus use the same course, so the drawn bus is at each stop from its forecast arrival to departure (`tests/transit/forecast.test.mts`, `tests/map/buses.test.mts`). A bus on no known trip is drawn along its line. `tracking.mts` follows a bus fix by fix, as the map does live and scoring replays.

**What the map draws** (`src/map/render/buses.mts`): each bus at the model's estimate of now, which is its course timed from its last fix by our clock, at most 45 s past it. A new fix or course moves where the model has the bus, and the drawn bus follows it (`smoothed`) rather than jumping: a frame on, it moves at the model's speed plus the gap over 4 s, never backwards, never slower than half the model's speed while ahead of it, and never more than 12 m/s over the model's speed while behind. It jumps only to a bus first drawn, on another line, hidden for over 5 s, or more than 300 m off. The smoothing is presentation only, and its cost and gain are measured as such on Oct 15's fixes: the drawn bus is more than 20 m from the model's point 370 s a bus-hour against 192 for waiting on the model to catch up, as it converges instead of snapping, and closes at 10 m/s over the model's speed at the 90th percentile against 29. That it never stands while the model drives (0 s a bus-hour, against 152 before, and 481 before the slow-bus hold) follows from the half-speed rule by construction, and says nothing about where the bus is. Nothing learned comes from where a bus was drawn.

Resetting pace after a break, per-time-of-day pace per bus, and a mixture model for held-up legs measured no better than one bounded spread.

## Forecasting departures

`src/transit/models/forecast.mts` produces every departure shown.

- **A followed bus** is forecast along its course; how much longer it stays at a stop depends on how long it's been there. Where its trip ends at the start of a later trip, it continues through a layover into the next trip of its GTFS block, else the trip due to start there soonest after its own is due to end, by the timetable rather than the clock (so a bus running late goes on into the trip it's late for, not the one after), within 30 min; Umo's word on which trip it runs next comes first. It goes on so from trip to trip for as long as that foretells better than the timetable: about 70 min on the headway routes. Those continuations are expected, not live, until seen. Of two buses on one trip, the one nearer its time runs it. A bus of a timetabled route tagged with a trip it's more than 15 min ahead of is on its way round to where it starts, or running it on an earlier trip's slot: it's chained on to the end as usual and then around to the stops before it, rather than those being put in the past.
- **Timetabled routes** (3 and 4, which mark timepoints) are forecast from the timetable shifted by how late the route runs, from 30 min ahead on. Runs with no bus followed, and the headway routes beyond 70 min, are shifted likewise.
- **Headway routes** with no bus followed show how often buses come and how soon the next likely does, rather than timetable times.
- **Umo's predictions** assign buses to trips and cancel runs, and set times only for a bus or route the model can't follow. Umo's schedule-based start guesses are ignored.

**Bands.** How far off a departure may be, which the planner's slack and the reminders' lead allow for (`spreadTo`): for a followed bus, its chain's spread scaled by how far off the model's forecasts have turned out at that lead (`bandScale`), never under the 30 s a boarding takes, and no longer clipped at 240 s, which on Oct 15 cut off 91 % of bands 30 min ahead and caught 81 % of buses for the 85 % asked; a stop handed off to the timetable has no chain variance (`tracked.variances[i]` is undefined there) and gets the timetable's band whole, the route's lateness variance, the same as a run with no bus followed, rather than the chain's calibration on top of it; with nothing learned, a fixed spread growing with the lead, capped at 240 s and doubled for a time from the timetable alone.

A run's times aren't forced into order. The planner's connections never go back in time (`buildConnections`), which a property test checks.

Held out a day at a time on Oct 7 to 19, the median error of a followed bus's departures went from 60, 126, and 202 s to 28, 50, and 75 s at 1, 5, and 10 minutes ahead. Replayed forward on Oct 8 to 19, the mean error of what the map shows for every departure is below the timetable's and Umo's at every lead from 1 to 60 minutes (86, 148, 204, 269, 363, and 435 s at 1, 5, 10, 20, 30, and 60 minutes, against the timetable's 505 s and Umo's 117, 189, 271, 364, 419, and 394 s on the departures it predicted); before the continuation and start fixes it was worse than both from 30 minutes on.

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

**Scoring.** Each day is replayed (`scripts/map/replay.mts`) at every 5-minute sample from a minute to just over an hour before each departure, using the fixes the map would have seen in poll order and Umo's word as sampled then, once the sample was all in (`received` on a `PredictionSample`, the last poll's answer, from `RAW_VERSION` 2; rows before that say only their minute, so Oct 20 is the first day read so), each forecast scored once at the nearest of 1, 3, 5, 10, 20, 30, and 60 minutes. The `model` column is what the map would have shown for the departure, a followed bus's chain or the shifted timetable, by how far ahead of the departure it was made, so it's scored on the same departures as the `schedule` column, less the few Umo's word had as not coming; `tracked` is the chain alone, only where it foretells the stop (not where the stop is handed off to the timetable), by the lead it was forecast at, as the map and the Worker ask for its band, and the ratios of error to band that calibrate the bands are binned likewise, leaving out a forecast that has the bus past the stop already, whose band says nothing of a bus still to come; `umo` is Umo's prediction sampled then. Moments the Worker wasn't listening aren't scored. Bump `FORECAST` (`forecast.mts`) with any forecasting change and `REPLAY` (`replay.mts`) with any scoring change. On Oct 19, with the slow-bus hold and the unclipped bands (`FORECAST` 3), the model's mean error went from 117, 148, 169, 216, 269, 359 and 439 s to 110, 135, 162, 209, 262, 355 and 440 s at 1, 3, 5, 10, 20, 30 and 60 minutes; by predicted lead, the chain alone (`REPLAY` 4) is 544, 92, 116, 157, 192, 262 and 293 s.

The 1-minute figure is not buses lingering: of the 861 chain forecasts in that bin on Oct 19, 196 had the bus already past the stop (a negative predicted lead, a median 6 to 14 min before), while the bus really left 10 to 60 min later; they carry 83 % of the bin's error (1976 s against 122 s for the rest) with a chain sd of 11 s, so they are confident misses, not wide bands, at mid-trip stops, mostly on the Gables loop. Scored into the ratios, as `REPLAY` 3 did, they would have put the 1-minute band scale at 2.03 on Oct 19 alone and a worse day short of 50; left out, it is 1.27, as the served model has it. **Follow-up:** how a followed bus on the Gables loop gets placed 10 to 60 minutes ahead of itself at mid-trip stops (`placed` in `forecast.mts` takes the scheduled visit nearest in time, and a loop visits a stop twice) is unexplained; the reviewer's `rv-tail.mts` lists the stops. Until it is, the Worker says a bus is gone only once its scheduled time has gone too ([reminders.md](reminders.md)).

**Versions.** The model's shape `version` is 4. A stored model of another version is refit from the first day observed.

**Learning.** `scripts/learn.mts` continues from the model D1 stores, folds in each whole day since, and stores the result compare-and-swap. A day it can't read stops it there; the next night carries on. A rebuild (`gh workflow run inputs.yml -f rebuild=true`, or `npm run model -- --store --rebuild`) runs to the end in one job, reusing matching derived data, and isn't stored if cut short. A model of a new version is stored however far it gets.

## Trip planning

`src/routing/plan.mts`: the [Connection Scan Algorithm](https://arxiv.org/abs/1703.05997) over the day's forecast runs, plus a reverse scan so each option leaves as late as possible.

- Each connection carries its uncertainty: the chain's spread scaled to observed forecast error at that lead, or the route's lateness variance.
- Umo is seen only as observations. A trip due at a stop within Umo's predicted range that Umo doesn't mention is dropped. Predictions older than three polls are dropped.
- Each stop time's pickup and drop-off rules ("Arrivals Only") are honored.
- How early to be at a stop weighs the learned chance the bus waits for its scheduled time.
- Walks come from `src/routing/walks.mts` ([map.md](map.md)); an estimated walk gets more slack.
- Itineraries persist across replans only while they'd show the same; the chosen one is remembered by key.
- **Arrive by** (`planBy`): the latest-leaving ways that get there by a time, over the scans `plan` runs, stepped through each first bus until one is due too late, and a minute at a time past a start walking would beat any bus from, as a bus leaving later may yet make it. The connections scanned reach to the time asked, however far ahead (a goal saved for tomorrow morning, opened tonight, is 13 hours out; 20 to 35 ms on the bundled timetable), not only `HORIZON`'s four hours. The earliest arrival never gets earlier for a later start, so the latest start that arrives in time is exact. Each way kept has to feel better than walking so as to be there then by the same `MIN_TIME_SAVED` as `plan` asks against walking now (`betterThanWalking`), with `cost` counting the time there before the time asked as its own (`EARLY_THERE`), so a bus that gets a 300 m walk there 20 minutes early isn't offered, and the last bus of the evening for a 9 PM goal is. When nothing makes it, the map shows the ways leaving now, soonest first, and says so. Walking the whole way is offered so as to be there at the time, its allowance left as before a bus (`walkBy`).
