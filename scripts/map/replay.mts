// How well departures could have been foreseen on a day: for every visit on a known trip, at each of the model's
// lead times before it left, a forecast from the timetable alone, one from where the bus was and the model, and
// Umo's own prediction sampled then. Run directly on a day of samples to see how each did:
// BUILD_TOKEN=… node scripts/map/replay.mts 2026-10-07 [--local]

import { readFile } from "node:fs/promises"
import { withIndexes, type Feed, type FeedData } from "../../src/map/feed.mts"
import { extract, type Visit } from "../../src/map/events.mts"
import { decode, fromHex, unpackFixes, unpackPredictions, type RawFix, type RawPrediction, type SampledPrediction } from "../../src/map/raw.mts"
import { NO_PACE, expectedMu, paced } from "../../src/map/pace.mts"
import { NO_FORECAST, type Sighting, buildRuns, timeAt } from "../../src/map/forecast.mts"
import { LEADS, asModel, dayTypeAt, emptyScores, offsetEstimate, scored, type Model, type Scores } from "../../src/map/model.mts"
import { type Day, localDay } from "../../src/shared/time.mts"
import { groupBy } from "../../src/shared/group.mts"
import { readModel, readRows } from "../worker.mts"

export const FEED = new URL("../../src/map/gtfs.json", import.meta.url)

/** The timetable as the Worker archives each version of it: the feed, as of the day the build first saw it */
export type ArchivedFeed = FeedData & { through: Day }

/** The timetable fetched for this build */
export const localFeed = async () =>
  JSON.parse(await readFile(FEED, "utf8")) as FeedData

// The archived versions, by the day each was first seen, the latest of them read first and only once
const archived = new Map<Day, Promise<Feed>>()
let days: Promise<Day[]> | undefined

/**
 * The timetable in force on a day, for replaying it as the buses then ran it: the version archived last at or
 * before it, or the first archived for days before any was, or this build's own while none is
 */
export const feedFor = async (day: Day): Promise<Feed> => {
  const throughs = await (days ??= readModel<ArchivedFeed>("gtfs").then(({ state, throughs }) => {
    if (state)
      archived.set(state.through, Promise.resolve(withIndexes(state)))
    return throughs
  }))
  const through = throughs.findLast(through => through <= day) ?? throughs[0]
  if (through === undefined)
    return withIndexes(await localFeed())
  if (!archived.has(through))
    archived.set(through, readModel<ArchivedFeed>("gtfs", through).then(({ state }) => withIndexes(state!)))
  return archived.get(through)!
}

// Umo's predictions are sampled on minutes divisible by 5, so forecasts are made then
const SAMPLED = 300 // s
// A bus last seen at a stop longer ago than this, without leaving the route, is out of service
const OUT_OF_SERVICE = 1800 // s

/** When forecasts of a departure are made at each of LEADS: the last sample at least that long before it */
const forecastTimes = (depart: number) =>
  LEADS.map(minutes => Math.floor((depart - minutes * 60) / SAMPLED) * SAMPLED)

/**
 * Each visit with what Umo predicted for it at each lead: the soonest prediction sampled then for its bus at its
 * stop, when this visit is the bus's next one there and on the same trip
 */
export const attachPredictions = (visits: readonly Visit[], samples: readonly { at: number, predictions: readonly SampledPrediction[] }[]) => {
  const predicted = new Map<string, SampledPrediction>()
  for (const { at, predictions } of samples)
    for (const prediction of predictions)
      predicted.set(`${at / 1000} ${prediction.route} ${prediction.stop} ${prediction.vehicle}`, prediction)

  const previous = new Map<string, number>()
  return visits.map(visit => {
    const key = `${visit.route} ${visit.stop} ${visit.vehicle}`
    const before = previous.get(key) ?? -Infinity
    previous.set(key, visit.depart)
    const umo = forecastTimes(visit.depart).map(at => {
      const prediction = predicted.get(`${at} ${key}`)
      const isThis = prediction && before <= at && (!prediction.trip || !visit.trip || prediction.trip === visit.trip)
      return isThis ? prediction.at / 1000 : null
    })
    return umo.some(at => at !== null) ? { ...visit, umo } : visit
  })
}

/**
 * What the map would have seen of the buses at any epoch second of a day, from its visits: each bus's trip, the
 * stop it was at or last left, and its pace from the legs it drove before, as pace.mts learns them live
 */
export const sightingsOf = (model: Model, visits: readonly Visit[]) => {
  const buses = [...groupBy(visits, visit => visit.vehicle).entries()].map(([vehicle, own]) => {
    own = own.toSorted((a, b) => a.arrive - b.arrive)
    let pace = NO_PACE
    const paces = own.map(({ route, stop, from, meters, left, arrive }) =>
      pace = from !== undefined && left !== undefined && arrive > left
        ? paced(pace, Math.log(arrive - left) - expectedMu(model, route, from, stop, meters!, arrive), arrive)
        : pace
    )
    return { vehicle, own, paces }
  })
  return (at: number): Sighting[] => buses.flatMap(({ vehicle, own, paces }) => {
    const i = own.findLastIndex(visit => visit.arrive <= at)
    const visit = own[i]
    if (!visit?.trip || (visit.depart <= at ? visit.depart : at) < at - OUT_OF_SERVICE)
      return []
    return [{
      vehicleId: vehicle, tripId: visit.trip, stop: visit.stop, arrive: visit.arrive,
      ...visit.depart <= at && { depart: visit.depart },
      // Its pace as of the last leg it drove, which it finished getting there
      pace: paces[i], at
    }]
  })
}

/**
 * How each way of forecasting did on a day's visits, as scores to fold into the model: at each sample time, every
 * departure still to come at a lead is forecast as the map would have from what it would have seen then, by the
 * model as it stood before the day, against Umo's prediction sampled then and the timetable shifted by how late its
 * route runs
 */
export const score = (model: Model, feed: Feed, visits: readonly Visit[]): Scores => {
  const scores = emptyScores()
  const trips = new Map(feed.trips.map(trip => [trip.id, trip]))
  const sightingsAt = sightingsOf(model, visits)
  const due = new Map<number, { visit: Visit, lead: number, umo?: number | null }[]>()
  for (const visit of visits)
    if (visit.trip !== undefined && trips.has(visit.trip) && visit.position !== undefined && visit.scheduled !== undefined)
      forecastTimes(visit.depart).forEach((at, i) => due.set(at, [...due.get(at) ?? [], { visit, lead: visit.depart - at, umo: visit.umo?.[i] }]))

  for (const [at, departures] of due) {
    const runs = groupBy(buildRuns(feed, localDay(at * 1000), NO_FORECAST, model, sightingsAt(at)), run => `${run.trip.id}@${run.base}`)
    for (const { visit, lead, umo } of departures) {
      const trip = trips.get(visit.trip!)!
      const run = runs.get(`${trip.id}@${visit.scheduled! - trip.times[visit.position!]}`)?.[0]
      if (run?.tracked)
        scored(scores, "model", lead, visit.depart - timeAt(run, visit.position!), Math.sqrt(run.tracked.variances[visit.position!]))
      if (umo !== null && umo !== undefined)
        scored(scores, "umo", lead, visit.depart - umo)
      scored(scores, "schedule", lead, visit.depart - visit.scheduled! - (offsetEstimate(model, visit.route, dayTypeAt(visit.depart))?.mean ?? 0))
    }
  }
  return scores
}

/** Each lead's scores as a line: how far off each way of forecasting was on average */
export const describe = (scores: Scores) =>
  LEADS.map((minutes, i) => {
    const kinds = (["model", "umo", "schedule"] as const).map(kind => {
      const [n, error] = scores[kind][i]
      return n ? `${kind} ${Math.round(error / n)} s off (n ${Math.round(n)})` : `${kind} -`
    })
    return `${String(minutes).padStart(2)} min: ${kinds.join(", ")}`
  }).join("\n")

/** A row of samples as the Worker keeps them, at the epoch millisecond its minute starts */
type Row = { at: number, body: string }

/** A row's samples, or none if it can't be read, so one bad row costs its minute rather than the day */
const samplesOf = <T,>({ at, body }: Row) =>
  decode<T>(fromHex(body)).catch(error => {
    console.warn(`Skipped the samples of ${new Date(at).toISOString()}: ${error instanceof Error ? error.message : error}`)
    return [] as T[]
  })

/** Each visit a service day's samples show, with Umo's predictions for them */
export const extractDay = async (feed: Feed, day: Day) => {
  const [buses, predictions] = await Promise.all(["buses", "predictions"].map(name => readRows<Row>(name, day)))
  const fixes = await Promise.all(buses.map(async row => unpackFixes(row.at, await samplesOf<RawFix>(row))))
  const samples = await Promise.all(predictions.map(async row =>
    ({ at: row.at, predictions: unpackPredictions(row.at, await samplesOf<RawPrediction>(row)) })
  ))
  return attachPredictions(extract(feed, fixes.flat()), samples)
}

if (import.meta.main) {
  const day = process.argv.slice(2).find(arg => !arg.startsWith("--"))!
  const feed = await feedFor(day)
  const model = asModel((await readModel("buses")).state)
  const visits = await extractDay(feed, day)
  console.log(`${day}: ${visits.length} visits on timetable ${feed.version}, scored with the model through ${model.through ?? "nothing"}\n${describe(score(model, feed, visits))}`)
}
