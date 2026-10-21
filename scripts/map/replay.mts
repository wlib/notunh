// How well departures could have been foreseen on a day. For every visit on a known trip, at each 5-minute sample
// from a minute to just over an hour before it left, three forecasts are scored by how far ahead they were made:
// the timetable shifted by how late the route runs, what the map would have shown (a followed bus's chain where
// there was one, else that timetable, with the chain's own tally beside it), and Umo's own prediction sampled then.
// Where the bus was is what the map would have made of its fixes then, replayed through the same location model and
// pace in the order they arrived. Each day is replayed against the timetable in effect then, of those acquired. Run
// directly on a day of samples to see how each did:
// node --env-file=.dev.vars scripts/map/replay.mts 2026-10-07 [--local]

import { readFile } from "node:fs/promises"
import { URL } from "node:url"
import { withIndexes, serviceDayStart, type Feed, type FeedData } from "../../src/transit/feed.mts"
import { extract, type Visit } from "../../src/transit/inference/events.mts"
import { type Observations, type SampledPrediction, alwaysListening, listening } from "../../src/transit/observations/raw.mts"
import { observationsOf } from "../observations.mts"
import { NO_FORECAST } from "../../src/transit/observations/predictions.mts"
import { FORECAST, buildRuns } from "../../src/transit/models/forecast.mts"
import { sightingsFrom } from "../../src/transit/models/tracking.mts"
import { LEADS, asModel, dayTypeAt, emptyScores, scored, type Model, type Scores } from "../../src/transit/models/model.mts"
import { offsetEstimate } from "../../src/transit/models/estimates.mts"
import { HALF_LIFE } from "../../src/shared/learn.mts"
import { contentHash } from "../../src/shared/hash.mts"
import { type Day, addDays, localDay } from "../../src/shared/time.mts"
import { groupBy } from "../../src/shared/group.mts"
import { readModel, request } from "../worker.mts"
import { STAGED } from "../files.mts"

/** Where the timetable is among the inputs, and the GTFS zip it was converted from, which gtfs.mts keeps beside it */
export const FEED = "src/map/gtfs.json"
export const ORIGINAL = "src/map/gtfs.zip"

// The version of replaying and scoring here, bumped with any change to how a day is evaluated. 2 scores every
// sample before a departure once, by its lead, and the model as what the map shows, tracked or not
const REPLAY = 2

/** What an evaluation is of: forecasting, the replay that scores it, and the half-life the model is learned with */
export const PREDICTOR = `forecast ${FORECAST}, replay ${REPLAY}, half-life ${HALF_LIFE}`

/** A timetable as acquired (worker/schema.mts feeds): its id, when, and the days it says it runs, "" for none */
export type Acquisition = { id: string, acquired: number, version: string, start: Day | "", end: Day | "" }

/**
 * Of the timetables acquired, the earliest first, which a day's buses ran by: of those whose own days don't leave the
 * day out, the last acquired by the day's end. Before any was, it's the first whose own days name the day, which
 * then says it ran by it, though acquired later. With neither, there's no knowing which, and it's undefined
 */
export const inEffect = (acquired: readonly Acquisition[], day: Day) => {
  const covering = acquired.filter(({ start, end }) => (!start || start <= day) && (!end || day <= end))
  return covering.findLast(feed => feed.acquired < serviceDayStart(addDays(day, 1))) ?? covering.find(({ start, end }) => start && end)
}

// The timetables acquired, listed once, and each read once
let acquisitions: Promise<Acquisition[]> | undefined
const feeds = new Map<string, Promise<Feed>>()

/**
 * The timetable in effect on a day, for replaying it as the buses then ran it, with its id and whether it was only
 * acquired after the day, or undefined if none acquired was
 */
export const feedFor = async (day: Day) => {
  const found = inEffect(await (acquisitions ??= request<Acquisition[]>("/api/feeds")), day)
  if (!found)
    return
  if (!feeds.has(found.id))
    feeds.set(found.id, request<FeedData>(`/api/feeds/${found.id}`).then(withIndexes))
  return { id: found.id, feed: await feeds.get(found.id)!, isLater: found.acquired >= serviceDayStart(addDays(day, 1)) }
}

/**
 * Acquires the timetable among the inputs being made, with the GTFS it was converted from, unless it's the one last
 * acquired
 * @returns whether it was
 */
export const acquireFeed = async () => {
  const [json, original] = await Promise.all([readFile(new URL(FEED, STAGED), "utf8"), readFile(new URL(ORIGINAL, STAGED))])
  const { version, start, end } = JSON.parse(json) as FeedData
  const form = new FormData()
  for (const [name, value] of Object.entries({ id: await contentHash(json), source: await contentHash(original), version, start, end }))
    form.set(name, value)
  form.set("feed", new Blob([json], { type: "application/json" }))
  form.set("original", new Blob([original], { type: "application/zip" }))
  return (await request<{ acquired: boolean }>("/api/feeds", form)).acquired
}

// Umo's predictions are sampled on minutes divisible by 5, so forecasts are made then, at every sample from a minute
// before a departure back to just past the last of LEADS
const SAMPLED = 300 // s
const SAMPLES = LEADS.at(-1)! * 60 / SAMPLED + 1
// The Worker polls buses every 10 s, so a silence longer than this between answers may have missed a bus. A forecast
// is only scored where the Worker was listening for the minute before, so what replay saw then is what the map would
const QUIET = 30_000 // ms
const LISTENED = 60  // s

/** When forecasts of a departure are made: each sample from the last at least a minute before it, SAMPLES back */
export const forecastTimes = (depart: number) =>
  Array.from({ length: SAMPLES }, (_, k) => Math.floor((depart - 60) / SAMPLED) * SAMPLED - k * SAMPLED)

/** A visit with what Umo predicted for it, in epoch seconds, at each of its forecastTimes, null where it didn't */
export type Predicted = Visit & { umo?: (number | null)[] }

/**
 * Each visit with what Umo predicted for it at each of its forecast times: the prediction sampled then for its bus at
 * its stop, when this visit is the bus's next one there and on the same trip. A bus predicted at a stop for more
 * than one loop is taken at the soonest, which is the next visit's
 */
export const attachPredictions = (visits: readonly Visit[], samples: Observations["predictions"]): Predicted[] => {
  const predicted = new Map<string, SampledPrediction>()
  for (const { at, predictions } of samples)
    for (const prediction of predictions) {
      const key = `${at / 1000} ${prediction.route} ${prediction.stop} ${prediction.vehicle}`
      const kept = predicted.get(key)
      if (!kept || prediction.at < kept.at)
        predicted.set(key, prediction)
    }

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
 * How each way of forecasting did on a day's visits, as scores to fold into the model. At each sample time the
 * Worker was listening up to, every departure within the leads is forecast as the map would have from the day's
 * fixes it would have seen then, by the model as it stood before the day: the run's time, which is a followed bus's
 * chain where there is one, else the timetable shifted by how late its route runs. That's scored by its lead beside
 * the chain alone, Umo's prediction sampled then, and the shifted timetable
 */
export const score = (model: Model, feed: Feed, visits: readonly Visit[], { fixes, predictions }: Pick<Observations, "fixes" | "predictions">, isListening = alwaysListening): Scores => {
  const scores = emptyScores()
  const trips = new Map(feed.trips.map(trip => [trip.id, trip]))
  const sightingsAt = sightingsFrom(feed, model, fixes)
  const due = new Map<number, { visit: Visit, lead: number, umo?: number | null }[]>()
  for (const visit of attachPredictions(visits, predictions))
    if (visit.trip !== undefined && trips.has(visit.trip) && visit.position !== undefined && visit.scheduled !== undefined)
      forecastTimes(visit.depart).forEach((at, i) => due.set(at, [...due.get(at) ?? [], { visit, lead: visit.depart - at, umo: visit.umo?.[i] }]))

  for (const at of [...due.keys()].sort((a, b) => a - b)) {
    if (!isListening((at - LISTENED) * 1000, at * 1000))
      continue
    const runs = groupBy(buildRuns(feed, localDay(at * 1000), NO_FORECAST, model, sightingsAt(at)), run => `${run.trip.id}@${run.base}`)
    for (const { visit, lead, umo } of due.get(at)!) {
      const trip = trips.get(visit.trip!)!
      const run = runs.get(`${trip.id}@${visit.scheduled! - trip.times[visit.position!]}`)?.[0]
      if (run) {
        scored(scores, "model", lead, visit.depart - run.departures[visit.position!])
        if (run.tracked)
          scored(scores, "tracked", lead, visit.depart - run.departures[visit.position!], Math.sqrt(run.tracked.variances[visit.position!]))
      }
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
    const kinds = (["model", "tracked", "umo", "schedule"] as const).map(kind => {
      const [n, error] = scores[kind][i]
      return n ? `${kind} ${Math.round(error / n)} s off (n ${Math.round(n)})` : `${kind} -`
    })
    return `${String(minutes).padStart(2)} min: ${kinds.join(", ")}`
  }).join("\n")

/** Each visit a day's observations show */
export const visitsOf = (feed: Feed, { fixes }: Observations) =>
  extract(feed, fixes)

/** When the Worker was listening for buses, as a day's observations say */
export const listeningOf = ({ coverage }: Observations) =>
  listening(coverage.buses, QUIET)

if (import.meta.main) {
  const day = process.argv.slice(2).find(arg => !arg.startsWith("--"))!
  const timetable = await feedFor(day)
  if (!timetable)
    throw new Error(`No timetable acquired says it ran on ${day}`)
  const model = asModel((await readModel("buses")).state)
  const observed = await observationsOf(day)
  const visits = visitsOf(timetable.feed, observed)
  console.log(`${day}: ${visits.length} visits on timetable ${timetable.feed.version}, scored with the model through ${model.through ?? "nothing"}\n${describe(score(model, timetable.feed, visits, observed, listeningOf(observed)))}`)
}
