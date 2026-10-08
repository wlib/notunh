// How well departures could have been foreseen on a day: for every visit on a known trip, at each of the model's
// lead times before it left, a forecast from the timetable alone, one from where the bus was and the model, and
// Umo's own prediction sampled then. Run directly on a day of samples to see how each did:
// BUILD_TOKEN=… node scripts/map/replay.mts 2026-10-07 [--local]

import { readFile } from "node:fs/promises"
import { distance, withIndexes, type Feed } from "../../src/map/feed.mts"
import { extract, type Visit } from "../../src/map/events.mts"
import { decode, fromHex, unpackFixes, unpackPredictions, type RawFix, type RawPrediction, type SampledPrediction } from "../../src/map/raw.mts"
import { STREET_DETOUR } from "../../src/map/geometry.mts"
import { DEFAULT_RATE, DEFAULT_WAIT, FACTOR_WINDOW, ZONE, factorOf, type Seen } from "../../src/map/pace.mts"
import {
  LEADS, asModel, context, contextAt, dayType, deviationEstimate, driveEstimate, dwellEstimate, emptyScores,
  heldPositions, inflation, probit, variance, type Estimate, type Model, type Scores, type Tally
} from "../../src/map/model.mts"
import { type Day, localDay } from "../../src/shared/time.mts"
import { readModel, readRows } from "../worker.mts"

export const FEED = new URL("../../src/map/gtfs.json", import.meta.url)

// Umo's predictions are sampled on minutes divisible by 5, so forecasts are made then
const SAMPLED = 300 // s
// How much a stretch or stop the model knows nothing of varies
const DEFAULT_SIGMA = 0.3 // log s
// How far either side of a forecast its 10 to 90 % band goes, in standard deviations
const BAND = probit(0.9)
// The mean absolute deviation of a normal distribution, per standard deviation
const MEAN_ABSOLUTE = Math.sqrt(2 / Math.PI)

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

const tally = ([n, error, expected, inside]: Tally, off: number, spread: number, isInside: boolean): Tally =>
  [n + 1, error + Math.abs(off), expected + spread * MEAN_ABSOLUTE, inside + (isInside ? 1 : 0)]

/** Seconds and their variance of a lognormal estimate's median, or of a default with a typical spread */
const timed = (estimate: Estimate | undefined, fallback: number) =>
  estimate
    ? { seconds: Math.exp(estimate.mu), variance: variance(estimate) }
    : { seconds: fallback, variance: variance({ mu: Math.log(fallback), sigma: DEFAULT_SIGMA, n: 0 }) }

/**
 * How each way of forecasting did on a day's visits, as scores to fold into the model: each forecast is made at a
 * sample time, from what was known then, by the model as it stood before the day
 */
export const score = (model: Model, feed: Feed, visits: readonly Visit[]): Scores => {
  const scores = emptyScores()
  const trips = new Map(feed.trips.map(trip => [trip.id, trip]))
  const stopsById = new Map(feed.stops.map(stop => [stop.id, stop]))
  // The meters between stops' zones as driven, else as the crow flies and then some
  const meters = new Map<string, number>()
  for (const { from, stop, meters: driven } of visits)
    if (from !== undefined)
      meters.set(`${from}>${stop}`, driven!)
  const metersOf = (from: string, to: string) =>
    meters.get(`${from}>${to}`) ?? distance(stopsById.get(from)!, stopsById.get(to)!) * STREET_DETOUR

  // Every drive by route in order, as evidence of how each was running
  const drives = new Map<string, Seen[]>()
  for (const visit of visits)
    if (visit.from !== undefined) {
      const seconds = visit.arrive - visit.left!
      const estimate = driveEstimate(model, visit.route, `${visit.from}>${visit.stop}`, visit.meters!, contextAt(visit.left!))
      const mu = estimate?.mu ?? Math.log(Math.max(1, visit.meters!) / DEFAULT_RATE)
      const seen = drives.get(visit.route) ?? []
      seen.push({ seconds, at: visit.arrive, excess: Math.log(seconds) - mu })
      drives.set(visit.route, seen)
    }
  for (const seen of drives.values())
    seen.sort((a, b) => a.at - b.at)
  // The drives on a route that had ended by a time, recent enough to count
  const drivesBy = (route: string, at: number) => {
    const seen = drives.get(route) ?? []
    let [end, high] = [0, seen.length]
    while (end < high) {
      const middle = (end + high) >> 1
      if (seen[middle].at <= at)
        end = middle + 1
      else
        high = middle
    }
    let start = end
    while (start > 0 && at - seen[start - 1].at <= FACTOR_WINDOW)
      start--
    return seen.slice(start, end)
  }

  const byVehicle = Map.groupBy(visits, visit => visit.vehicle)
  for (const visit of visits) {
    const trip = visit.trip === undefined ? undefined : trips.get(visit.trip)
    if (!trip || visit.position === undefined || visit.scheduled === undefined)
      continue
    const base = visit.scheduled - trip.times[visit.position]
    // Its service day, by noon on it
    const day = localDay((base + 43_200) * 1000)
    const held = heldPositions(model, feed, trip)
    const deviation = deviationEstimate(model, trip.route, visit.stop, dayType(day))

    forecastTimes(visit.depart).forEach((at, i) => {
      // Where the bus was: the last stop on this trip it had got to by then, which it may not have left yet. Which trip
      // that was comes from the whole day's tags, a little more than was known then, as Umo's predictions had too
      const last = byVehicle.get(visit.vehicle)!.findLast(other =>
        other.trip === visit.trip && other.arrive <= at && other.position! < visit.position! && visit.depart - other.depart < 3 * 3600
      )
      if (!last)
        return
      const factor = factorOf(drivesBy(trip.route, at), at)
      const dwellAt = (stop: string) =>
        timed(dwellEstimate(model, stop, dayType(day)), 2 * ZONE / DEFAULT_RATE + DEFAULT_WAIT)
      const still = last.depart > at ? dwellAt(last.stop) : undefined
      let [time, spread] = still ? [Math.max(at, last.arrive + still.seconds), still.variance] : [last.depart, 0]
      for (let position = last.position! + 1; position <= visit.position!; position++) {
        const [from, to] = [feed.stops[trip.stops[position - 1]].id, feed.stops[trip.stops[position]].id]
        const length = metersOf(from, to)
        const drive = timed(driveEstimate(model, trip.route, `${from}>${to}`, length, context(day, time - base)), Math.max(1, length) / DEFAULT_RATE)
        const dwell = dwellAt(to)
        time += drive.seconds * Math.exp(factor)
        // It hadn't got to the next stop yet
        if (position === last.position! + 1)
          time = Math.max(time, at)
        time += dwell.seconds
        spread += drive.variance + dwell.variance
        if (held[position])
          time = Math.max(time, base + trip.times[position])
      }
      time = Math.max(time, at)
      const sd = Math.sqrt(spread)
      const band = BAND * sd * inflation(model, visit.depart - at)
      scores.model[i] = tally(scores.model[i], visit.depart - time, sd, Math.abs(visit.depart - time) <= band)

      const umo = visit.umo?.[i]
      if (umo !== null && umo !== undefined)
        scores.umo[i] = tally(scores.umo[i], visit.depart - umo, sd, Math.abs(visit.depart - umo) <= band)

      // The timetable, shifted by how late the model has the route running there
      const off = visit.depart - visit.scheduled! - (deviation?.mu ?? 0)
      scores.schedule[i] = tally(scores.schedule[i], off, deviation?.sigma ?? 0, deviation !== undefined && Math.abs(off) <= BAND * deviation.sigma)
    })
  }
  return scores
}

/** Each lead's scores as a line: how far off each forecast was on average, and how often within the model's band */
export const describe = (scores: Scores) =>
  LEADS.map((minutes, i) => {
    const kinds = (["model", "umo", "schedule"] as const).map(kind => {
      const [n, error, , inside] = scores[kind][i]
      return n ? `${kind} ${Math.round(error / n)} s off (${Math.round(100 * inside / n)} % in band, n ${Math.round(n)})` : `${kind} -`
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
  const feed = withIndexes(JSON.parse(await readFile(FEED, "utf8")))
  const model = asModel(await readModel("buses"))
  const visits = await extractDay(feed, day)
  console.log(`${day}: ${visits.length} visits, scored with the model through ${model.through ?? "nothing"}\n${describe(score(model, feed, visits))}`)
}
