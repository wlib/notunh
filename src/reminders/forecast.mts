// What the model says of a watched run, as the Worker forecasts it from its own samples: the day's runs built once a
// check from the whole timetable, the buses followed across every route and the source's latest word, through the
// same buildRuns the map uses, so a reminder's "leave" is as good as the map's times and a bus going on from another
// route is followed onto this one. Pure: the Worker (worker/reminders.mts) reads the samples and hands them here

import type { Feed } from "../transit/feed.mts"
import type { Model } from "../transit/models/model.mts"
import { type Run, SCHEDULE_FACTOR, buildRuns, slack, uncertainty } from "../transit/models/forecast.mts"
import { type Forecast, NO_FORECAST } from "../transit/observations/predictions.mts"
import type { BusFix } from "../transit/observations/raw.mts"
import { sightingsFrom } from "../transit/models/tracking.mts"
import { localDay } from "../shared/time.mts"
import { GONE, type Seen, type Watch } from "./watch.mts"

/** s a run's scheduled time at the stop may differ from the watch's and still be its run, as a swapped timetable may move it a little */
const NEAR = 300

/**
 * The watched run among the day's, with the stop's position on it: the trip at its scheduled time at the stop, or
 * failing the trip's id, as a timetable since swapped may rename it, the route's run due at the stop nearest then
 */
export const runOf = (feed: Feed, runs: readonly Run[], { at, run: watched }: Watch) => {
  let best: { run: Run, position: number, off: number } | undefined
  if (!watched)
    return best
  for (const run of runs)
    if (run.trip.route === watched.route)
      run.trip.stops.forEach((index, position) => {
        if (feed.stops[index].id !== watched.stop)
          return
        const off = Math.abs(run.base + run.trip.times[position] - at) + (run.trip.id === watched.trip ? 0 : NEAR)
        if (off <= 2 * NEAR && off < (best?.off ?? Infinity))
          best = { run, position, off }
      })
  return best
}

/** The day's runs at an epoch second, forecast from the buses as their fixes had them by then and the source's word */
export const runsAt = (feed: Feed, model: Model, fixes: readonly BusFix[], forecast: Forecast, now: number) =>
  buildRuns(feed, localDay(now * 1000), forecast, model, sightingsFrom(feed, model, fixes)(now))

/** The day's runs as the timetable alone has them, which a run the forecast drops is cancelled against */
export const scheduledRuns = (feed: Feed, model: Model, now: number) =>
  buildRuns(feed, localDay(now * 1000), NO_FORECAST, model)

/**
 * What's said of a watch with no forecast to be had: a run's bus due as scheduled, give or take, or a fixed time to
 * leave, which is exactly that
 */
export const scheduledOnly = ({ at, run }: Watch, now: number): Seen =>
  ({ time: at, band: run ? uncertainty(at - now) * SCHEDULE_FACTOR : 0, isLive: false, status: now > at + GONE ? "passed" : "coming" })

/**
 * What the forecast says of a watch's run at an epoch second: when its bus leaves the stop, how early to be there for
 * it, whether a bus is on it, and whether it's still coming. A run the forecast hasn't is cancelled if the timetable
 * still has it, as the source then dropped it, and lost if it doesn't, as a timetable swapped since the watch was
 * set. A watch on no run is its fixed time, as there's nothing to forecast
 */
export const seenOf = (feed: Feed, runs: readonly Run[], scheduled: () => readonly Run[], watch: Watch, now: number): Seen => {
  if (!watch.run)
    return scheduledOnly(watch, now)
  const found = runOf(feed, runs, watch)
  if (!found)
    return { ...scheduledOnly(watch, now), status: runOf(feed, scheduled(), watch) ? "cancelled" : "lost" }
  const { run, position } = found
  const time = run.departures[position]
  return { time, band: slack(run, position, time, now), isLive: run.isLive, status: now > time + GONE ? "passed" : "coming" }
}
