// What the model says of a watched run, as the Worker forecasts it from its own samples: the buses it followed, the
// source's latest word, and the timetable, through the same buildRuns the map uses, so a reminder's "leave" is as
// good as the map's times. Pure: the Worker (worker/reminders.mts) reads the samples and hands them here

import { type Feed, withIndexes } from "../transit/feed.mts"
import type { Model } from "../transit/models/model.mts"
import { type Run, type Sighting, SCHEDULE_FACTOR, buildRuns, slack, uncertainty } from "../transit/models/forecast.mts"
import type { Forecast } from "../transit/observations/predictions.mts"
import { localDay } from "../shared/time.mts"
import { GONE, type Seen, type Watch } from "./watch.mts"

/** s a run's scheduled time at the stop may differ from the watch's and still be its run, as a swapped timetable may move it a little */
const NEAR = 300

/** A route's trips alone, which is all forecasting one of its runs needs, and a tenth of the work */
export const routeFeed = (feed: Feed, route: string): Feed =>
  withIndexes({ ...feed, trips: feed.trips.filter(trip => trip.route === route) })

/**
 * The watched run among the day's, with the stop's position on it: the trip at its scheduled time at the stop, or
 * failing the trip's id, as a timetable since swapped may rename it, the route's run due at the stop nearest then
 */
export const runOf = (feed: Feed, runs: readonly Run[], { route, stop, trip, scheduled }: Watch) => {
  let best: { run: Run, position: number, off: number } | undefined
  for (const run of runs)
    if (run.trip.route === route)
      run.trip.stops.forEach((index, position) => {
        if (feed.stops[index].id !== stop)
          return
        const off = Math.abs(run.base + run.trip.times[position] - scheduled) + (run.trip.id === trip ? 0 : NEAR)
        if (off <= 2 * NEAR && off < (best?.off ?? Infinity))
          best = { run, position, off }
      })
  return best
}

/** What's said of a run with no forecast to be had, from the timetable alone: due as scheduled, give or take */
export const scheduledOnly = ({ scheduled }: Watch, now: number): Seen =>
  ({ time: scheduled, band: uncertainty(scheduled - now) * SCHEDULE_FACTOR, isLive: false, status: now > scheduled + GONE ? "passed" : "coming" })

/**
 * What the model foretells of a watch's run at an epoch second, from the buses as last seen and the source's word:
 * when its bus leaves the stop, how early to be there for it, whether a bus is on it, and whether it's still coming.
 * A run the day's runs don't have, as one the source says isn't coming, is cancelled
 */
export const seenOf = (feed: Feed, model: Model, watch: Watch, sightings: readonly Sighting[], forecast: Forecast, now: number): Seen => {
  const found = runOf(feed, buildRuns(feed, localDay(now * 1000), forecast, model, sightings), watch)
  if (!found)
    return { ...scheduledOnly(watch, now), status: "cancelled" }
  const { run, position } = found
  const time = run.departures[position]
  return { time, band: slack(run, position, time, now), isLive: run.isLive, status: now > time + GONE ? "passed" : "coming" }
}
