# Buses: locating, forecasting, planning

How the map knows where each bus is, when it'll leave each stop, and how to get somewhere. Everything here lives in the domain layers (`src/transit/`, `src/routing/`) and knows nothing of the page or MapLibre, so the nightly build trains and replays with exactly the code the map runs.

## Inputs

- **Live**: the Umo IQ rider API (`api.prd-1.iq.live.umoiq.com/v2.0/riders/agencies/unh`), the backend of `rider.umoiq.com`. No key and open CORS, so browsers poll it directly: vehicles every 5 s, predictions every 30 s for routes with a bus out. The API 403s once a URL passes about 1 KB, so stop lists are chunked. `src/transit/observations/umo.mts` turns Umo's answers into a live source's observations; nothing past it reads Umo's shape.
- **Timetable**: Wildcat Transit's GTFS feed on National RTAP (the one Google Maps uses). It has no CORS, so the build converts it into `src/map/gtfs.json`. Umo's trip and stop ids match the GTFS ones. The first build to see a new feed version archives it in the Worker (`/api/models/gtfs`), so any day's visits are replayed against the timetable in force that day.
- **History**: the Worker's crons store every minute of fixes and predictions in D1, and the Observations workflow archives each day losslessly (see [storage.md](storage.md)). These raw samples are the source of truth; visits and models are readings of them.

## Where each bus is: the location model

`src/transit/inference/locate.mts`. GPS puts a bus within a few meters, but only every 10 to 30 s, so what's uncertain is what it did between fixes.

1. **Matching.** Each fix is matched to a place along one of its route's shapes by an HMM: weighed by how far off the street it is, its heading, and whether driving there from the previous place is plausible. Viterbi over a whole day for extraction; only the fixes so far when live.
2. **Between fixes.** The bus drove as buses do: accelerating to a cruising speed and braking, stopping or not at each stop on the way and dwelling there, or halting somewhere, for whatever time the gap leaves. This is integrated deterministically over a grid of cruising speeds and time splits.
3. **Output.** Each stop's arrival and departure as quantiles (10th, 50th, 90th percentile), how likely the bus stopped there, and how its time was spent along the leg from the previous stop.

The GPS likelihoods are fitted on the fixes of Oct 7 to 19, and describe the receivers and where buses stand rather than traffic, so they don't drift with the timetable:

- A fix is off its street by a half-normal with σ ≈ 2.5 m, except buses parked beside the route (as at a terminal lot, about 3 % of fixes), σ ≈ 26 m.
- How far a heading is off its street's depends on speed: a standing bus has mostly lost its heading.
- Whether a fix is of a bus standing still comes from its reported speed (the GPS reads a standing bus as 0 km/h; 1 to 5 km/h is creeping).
- A bus standing at a stop stands a few meters past it.

So a fix is at a stop exactly as likely as these say, and each visit carries that likelihood. There are no zones and nothing is timed by crossing one. What's left as a hard cutoff is a bound, documented where it's set: how far off its route a bus can be and still be on it, never backing up or exceeding 35 m/s, and creeping up to or away from a stop counting as being at it (which keeps departures where the surrounding fixes put them).

A particle filter was tried for this and measured too noisy.

## How a bus moves on: its course

`src/transit/models/movement.mts`. From where the location model has the bus, at its current speed, settling toward the pace that gets it to the next stop when the model expects:

- each leg as long as the model expects at this time of day, scaled by the bus's **pace**: a Kalman filter over how much longer than expected its recent legs took, drifting back to usual over about an hour;
- its time along the leg spent as buses' is (slower pulling out and in, and wherever the leg holds them up);
- each stop as long as buses dwell there, or until the scheduled time where the trip waits for the timetable.

The same course gives both where the map draws the bus and when it leaves each stop ahead, so the drawing and the departures never disagree. `tracking.mts` follows a bus one fix at a time through the location model and its pace, as the map does live and the nightly scoring replays.

Pace noise and leg noise are fitted on Oct 7 to 19 and stable from one held-out day to the next. Resetting pace after a break, a per-time-of-day pace per bus, and a mixture model for held-up legs all measured no better than one bounded spread.

## Forecasting departures

`src/transit/models/forecast.mts`. Every departure shown (a stop's list, a bus's stops, trip planning) comes from here.

- **A followed bus** is forecast along its course. How much longer it stays at a stop comes from how long it's been there. Where its trip ends at the start of a later trip of its route that service day, it continues through a layover into the trip due nearest when it could start (or the one Umo has it on next), if that's due at most 30 min after it could start or 60 min before (for a late bus). That continuation is expected, not live, until the bus is seen on it. Of two buses tagged with one trip, the one nearer its time runs it.
- **Timetabled routes** (3 and 4, which mark timepoints) are forecast from the timetable shifted by how late the route runs, from 30 min ahead on, since breaks and holds put buses back on schedule. Every run with no bus followed is its timetable shifted likewise.
- **Headway routes** with no bus followed: a stop's list says how often buses come and how soon the next likely does, rather than timetable times that say nothing of when they'll actually come.
- **Umo's predictions** say which buses run which trips and which runs aren't coming, and set times only for a bus on a trip the map isn't following, or a route the model knows nothing of. Umo's schedule-based guesses at when a bus will start a run are no better than the model's, so they're ignored.

A run's times are left as forecast rather than forced into order: a stop can come out sooner than the one before. Anything that needs a chronology (the planner's connections) sorts it.

Held out a day at a time on Oct 7 to 19, this took the median error of a followed bus's departures from 60, 126, and 202 s to 28, 50, and 75 s at 1, 5, and 10 minutes ahead, and of every departure from 65, 128, and 186 s to 32, 60, and 90 s. Following buses with the location model rather than zone crossings took a further 2 to 5 s off the median at 1 to 5 minutes on most days.

## The learned model

Each build fits `src/map/model.json` (`scripts/map/model.mts`). For each completed service day since the last:

1. **Extract** each bus's visits to stops from the Worker's samples (`src/transit/inference/events.mts`, through the location model). Each visit names the extractor version that read it (`EXTRACTOR`). Visits are stored back in D1.
2. **Summarize** the day (`summarize` in `src/transit/models/fit.mts`) and store the summary.
3. **Fold** the summary into decayed statistics with a 4-week half-life (`src/shared/learn.mts`), so a new semester takes over within a month. A refit, or a different half-life, folds stored summaries again rather than re-extracting.

The model keeps, keyed by stop and route ids (which last across timetables, unlike trip ids):
- each leg's time between consecutive stops, by route, weekday/weekend, and two-hour slot, whether driven or lost to GPS on the way (so a request stop passed costs nothing, and a highway stretch is still learned);
- how a leg's time is spent along it;
- dwell at each stop and layover at trip starts, by route, and how much longer a bus that's been at a stop a while still stays;
- whether early buses wait for their scheduled time;
- how late each route runs, and its headways by hour.

Every estimate leans on a broader one while it has little data (`src/transit/models/estimates.mts`): a leg's mean on legs of that length, a time of day on the leg's overall. An empty model has no estimates, and the map falls back on built-in constants.

What's learned from is bounded where the data has a clear gap between two kinds of thing, documented in `fit.mts` (a bus not driving a leg for over 10 min was doing something else; over 15 min at a stop is out of service). Weighing visits by how sure their times are made no difference worth keeping.

**Scoring.** Each day is also replayed (`scripts/map/replay.mts`): at 1, 3, 5, 10, 20, 30, and 60 minutes before each departure, the forecast the map would have made from the fixes it would have seen, in arrival order, against Umo's prediction and the timetable. How many of its own standard deviations the model turned out off sizes the slack the planner leaves.

**Versions.** The model's shape has a `version` (3). A stored model of another version is refit from the first day the Worker still has data for.

**Training vs published.** `scripts/learn.mts` stores what's being learned (`buses.training`, `laundry.training`) apart from what's published. Each learning build continues from the checkpoint, within the build's time budget, and publishes only once the checkpoint has caught up with the published model. So a multi-build refit never replaces a model with one through fewer days. Writes are compare-and-swap on the latest row's revision; two builds learning at once converge rather than overwrite. `npm run model -- --store --rebuild` refits from every stored visit.

## Trip planning

`src/routing/plan.mts`: the [Connection Scan Algorithm](https://arxiv.org/abs/1703.05997) over the day's runs as forecast, plus a reverse scan so each option leaves as late as possible.

- Each connection carries how far off its time may be: the chain's spread, scaled to how far off forecasts have actually been at that lead, or how much the route's lateness varies.
- The planner sees Umo only as observations: trips at stops, and how far ahead the source covers each route at each stop. A trip due at a stop Umo is predicting, within the range Umo covers, that Umo doesn't mention is dropped (the campus connectors run by headway, not to the timetable). Predictions older than three polls are dropped.
- Each stop time's own pickup and drop-off rules ("Arrivals Only" stops) are honored: the planner never boards or alights against them.
- How early to be at a stop weighs the chance the bus waits for its scheduled time, as learned, against how early it might leave otherwise. A bus that waits half the time gets most of the slack of one that never does.
- Walking legs come from `src/routing/walks.mts` (see [map.md](map.md)). An estimated walk gets more slack than one along the network, so a tight transfer on one isn't counted on.
- Itineraries persist across replans only while they'd show the same; the chosen one is remembered by its key.
