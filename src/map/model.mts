// What weeks of the Worker's samples show of how the buses run, folded together in the nightly build a service
// day at a time: how long each stretch between stops takes at each time of day, how long buses spend at each stop,
// whether they wait there for their scheduled time, how long they lay over between trips, and how far off the
// timetable they run. Every statistic decays by half every HALF_LIFE days, so a new semester takes over within a
// month, and every estimate leans on a broader one while it has little data of its own. An empty model has no
// estimates at all, so everything using it falls back on the constants it had before there was a model.
// Keys are stop and route ids, which last across timetables, never trip ids, which don't

import { serviceDayStart, type FeedData, type Trip } from "./feed.mts"
import type { Visit } from "./events.mts"
import { getJson } from "../shared/json.mts"
import { foldDay, type Learned } from "../shared/learn.mts"
import { type Day, localDay, weekday } from "../shared/time.mts"

// How many observations a broader estimate is worth to a narrower one
const DRIVE_KAPPA = 8
const KAPPA = 4
// Typical spreads, which a statistic's own leans on while it has few observations, as one observation has none
const DRIVE_SIGMA = 0.3     // log s
const DWELL_SIGMA = 0.6     // log s
const LAYOVER_SIGMA = 0.5   // log s
const DEVIATION_SIGMA = 120 // s
// The Beta prior on whether a bus early at a stop waits there, from whether the timetable says it does
const TIMEPOINT_PRIOR: [number, number] = [4, 1]
const OTHER_PRIOR: [number, number] = [1, 4]
// Observations further out than this many standard deviations count as this far, once a cell has MIN_CLIP of them
const CLIP_SIGMAS = 3
const MIN_CLIP = 10
// Cells decayed below this are dropped, keeping the model to what's still running
const MIN_N = 0.01

/** Minutes ahead that forecasts are scored at, each scoring those nearest it */
export const LEADS = [1, 3, 5, 10, 20]

/** A decayed count, sum, and sum of squares of observations */
export type Cell = [n: number, sum: number, sum2: number]

/**
 * How a forecast did at a lead: a decayed count, the sum of how far off it was, the sum of how far off the model's
 * spread said it would be, and how many fell within the model's 10 to 90 % band
 */
export type Tally = [n: number, error: number, expected: number, inside: number]

export type Scores = {
  /** From where the bus was and the model */
  model:    Tally[],
  /** Umo's own predictions */
  umo:      Tally[],
  /** The timetable as is */
  schedule: Tally[]
}

export type Model = Learned & {
  version:    1,
  /** log s between stops' zones, by "from>to" stop ids, by context */
  drives:     Record<string, (Cell | null)[]>,
  /** log s per m of every drive, by route, for stretches nobody's driven */
  paces:      Record<string, Cell>,
  /** log s in a stop's zone without waiting for a scheduled time, by stop id, by day type */
  dwells:     Record<string, (Cell | null)[]>,
  /** Visits arriving early that waited for their scheduled time, and that didn't, by "route@stop" */
  holds:      Record<string, [held: number, left: number]>,
  /** log s from getting in at the end of a trip to leaving on the next, by route */
  layovers:   Record<string, Cell>,
  /** s leaving after the scheduled time, by "route@stop" and by route, by day type */
  deviations: Record<string, (Cell | null)[]>,
  scores:     Scores
}

export type Estimate = { mu: number, sigma: number, n: number }

const tallies = () =>
  LEADS.map((): Tally => [0, 0, 0, 0])

export const emptyScores = (): Scores =>
  ({ model: tallies(), umo: tallies(), schedule: tallies() })

export const emptyModel = (): Model => ({
  version:    1,
  through:    null,
  drives:     {},
  paces:      {},
  dwells:     {},
  holds:      {},
  layovers:   {},
  deviations: {},
  scores:     emptyScores()
})

/** A model as loaded, or an empty one for anything that isn't one */
export const asModel = (value: unknown): Model =>
  (value as Model | undefined)?.version === 1 ? value as Model : emptyModel()

/** The model bundled at build time, or without one, an empty model, as the map works without */
export const loadModel = (url: string) =>
  getJson(url).then(asModel, emptyModel)

//#region Contexts

/** 0 for weekdays, 1 for weekends */
export const dayType = (day: Day) =>
  weekday(day) >= 5 ? 1 : 0

// Hours of the service day each band ends: early, midday, the afternoon peak, and evening, with night the rest
const BANDS = [9, 15, 19, 24]
const NIGHT_ENDS = 5

/** How many contexts there are: each band of the day, on weekdays and on weekends */
const CONTEXTS = 2 * (BANDS.length + 1)

/** The context of a time some seconds into a service day */
export const context = (day: Day, seconds: number) => {
  const hour = seconds / 3600
  const band = BANDS.findIndex(end => hour < end)
  return dayType(day) * (BANDS.length + 1) + (hour < NIGHT_ENDS || band === -1 ? BANDS.length : band)
}

let last = { minute: NaN, index: 0 }

/**
 * The context of an epoch second, in its service day in Durham, which runs on past midnight into the night, as the
 * timetable's times do
 */
export const contextAt = (at: number) => {
  // Asked for every stretch of every bus's route every frame, and only changing by the hour
  const minute = Math.floor(at / 60)
  if (minute !== last.minute) {
    const day = localDay((at - NIGHT_ENDS * 3600) * 1000)
    last = { minute, index: context(day, at - serviceDayStart(day) / 1000) }
  }
  return last.index
}

/** 0 for weekdays, 1 for weekends, in a context */
export const dayTypeOf = (index: number) =>
  Math.floor(index / (BANDS.length + 1))

//#endregion

//#region Folding in a day

const scaled = (cell: Cell | null, by: number): Cell | null =>
  cell && cell[0] * by >= MIN_N ? cell.map(x => x * by) as Cell : null

const scaledEach = <T,>(record: Record<string, T>, scale: (value: T) => T | null) =>
  Object.fromEntries(Object.entries(record).flatMap(([key, value]) => {
    const next = scale(value)
    return next === null || (Array.isArray(next) && next.every(cell => cell === null)) ? [] : [[key, next]]
  })) as Record<string, T>

/** Every statistic scaled by how much it still counts, dropping those that no longer do */
const scale = (model: Model, by: number): Model => {
  const cells = (cells: (Cell | null)[]) => cells.map(cell => scaled(cell, by))
  return {
    ...model,
    drives:     scaledEach(model.drives, cells),
    paces:      scaledEach(model.paces, cell => scaled(cell, by)),
    dwells:     scaledEach(model.dwells, cells),
    holds:      scaledEach(model.holds, ([held, left]) => (held + left) * by >= MIN_N ? [held * by, left * by] : null),
    layovers:   scaledEach(model.layovers, cell => scaled(cell, by)),
    deviations: scaledEach(model.deviations, cells),
    scores: Object.fromEntries(
      Object.entries(model.scores).map(([kind, tallies]) => [kind, tallies.map(tally => tally.map(x => x * by))])
    ) as Scores
  }
}

/** A cell with an observation added, clipped to the cell's range as it was before the day */
const added = (cell: Cell | null | undefined, x: number, before: Cell | null | undefined): Cell => {
  if (before && before[0] >= MIN_CLIP) {
    const { mu, sigma } = own(before)
    x = Math.min(mu + CLIP_SIGMAS * sigma, Math.max(mu - CLIP_SIGMAS * sigma, x))
  }
  const [n, sum, sum2] = cell ?? [0, 0, 0]
  return [n + 1, sum + x, sum2 + x * x]
}

/** Adds an observation to a record's cell for a context or day type */
const addTo = (record: Record<string, (Cell | null)[]>, before: Record<string, (Cell | null)[]>, key: string, size: number, index: number, x: number) => {
  const cells = record[key] ??= Array.from({ length: size }, () => null)
  cells[index] = added(cells[index], x, before[key]?.[index])
}

// A visit this much ahead of its timetable could have waited for it, and one leaving this close to its scheduled
// time did
const EARLY = 60 // s
const GRACE = 30 // s
// Further off the timetable than this, a bus counts as this far off
const MAX_DEVIATION = 900 // s

/** What a service day's visits add to a model, and how forecasts did that day */
const add = (before: Model, visits: readonly Visit[], scores: Scores): Model => {
  const next = structuredClone(before)
  for (const { stop, route, isEnd, arrive, depart, scheduled, from, meters, left, gotIn } of visits) {
    const type = dayTypeOf(contextAt(arrive))
    if (from !== undefined && left !== undefined) {
      addTo(next.drives, before.drives, `${from}>${stop}`, CONTEXTS, contextAt(left), Math.log(arrive - left))
      if (meters! > 0)
        next.paces[route] = added(next.paces[route], Math.log((arrive - left) / meters!), before.paces[route])
    }
    if (gotIn !== undefined)
      next.layovers[route] = added(next.layovers[route], Math.log(Math.max(1, depart - gotIn)), before.layovers[route])
    if (scheduled === undefined)
      continue

    const isEarly = arrive < scheduled - EARLY
    const hasLeft = depart < scheduled - GRACE
    if (isEarly) {
      const [waited, went] = next.holds[`${route}@${stop}`] ?? [0, 0]
      next.holds[`${route}@${stop}`] = hasLeft ? [waited, went + 1] : [waited + 1, went]
    }
    // Only where it couldn't have been waiting for the timetable, and not at either end, where it lays over
    if ((!isEarly || hasLeft) && !isEnd)
      addTo(next.dwells, before.dwells, stop, 2, type, Math.log(Math.max(1, depart - arrive)))
    const deviation = Math.min(MAX_DEVIATION, Math.max(-MAX_DEVIATION, depart - scheduled))
    for (const key of [`${route}@${stop}`, route])
      addTo(next.deviations, before.deviations, key, 2, type, deviation)
  }

  for (const kind of ["model", "umo", "schedule"] as const)
    next.scores[kind] = next.scores[kind].map((tally, i) => tally.map((x, j) => x + scores[kind][i][j]) as Tally)
  return next
}

/** The model with a service day's visits folded in, and how forecasts did that day added to its scores */
export const update = (model: Model, day: Day, visits: readonly Visit[], scores = emptyScores()) =>
  foldDay(model, day, scale, before => add(before, visits, scores))

//#endregion

//#region Estimates

/** A cell's own mean and spread */
const own = ([n, sum, sum2]: Cell): Estimate => {
  const mu = sum / n
  return { mu, sigma: Math.sqrt(Math.max(0, sum2 / n - mu * mu)), n }
}

/** Empirical Bayes: a cell's mean and spread pooled with a broader estimate's, weighed by how much data it has */
export const shrink = (cell: Cell | null | undefined, parent: Estimate, kappa: number): Estimate => {
  if (!cell || cell[0] <= 0)
    return parent
  const { mu, sigma, n } = own(cell)
  return {
    mu:    (n * mu + kappa * parent.mu) / (n + kappa),
    sigma: Math.sqrt((n * sigma ** 2 + kappa * parent.sigma ** 2) / (n + kappa)),
    n
  }
}

/** A cell's own mean, with a spread that leans on a typical one while it has few observations */
const alone = (cell: Cell, sigma: number, kappa: number) =>
  shrink(cell, { ...own(cell), sigma }, kappa)

const pooled = (cells: readonly (Cell | null)[] | undefined) =>
  cells?.reduce<Cell | null>((sum, cell) => cell && sum ? [sum[0] + cell[0], sum[1] + cell[1], sum[2] + cell[2]] : cell ?? sum, null)

/**
 * log s to drive from one stop's zone to the next's, some meters apart, in a context: from that stretch at that
 * time, else that stretch at any time, else the route's pace over that distance
 */
export const driveEstimate = (model: Model, route: string | undefined, pair: string, meters: number, index: number) => {
  const pace = route === undefined ? undefined : model.paces[route]
  const routeLevel = pace && alone(pace, DRIVE_SIGMA, DRIVE_KAPPA)
  const parent = routeLevel && { ...routeLevel, mu: routeLevel.mu + Math.log(Math.max(1, meters)) }
  const cells = model.drives[pair]
  const all = pooled(cells)
  if (!all)
    return parent
  const pairLevel = parent ? shrink(all, parent, DRIVE_KAPPA) : alone(all, DRIVE_SIGMA, DRIVE_KAPPA)
  return shrink(cells![index], pairLevel, DRIVE_KAPPA)
}

/** log s in a stop's zone on a day type: from that stop on that kind of day, else on any */
export const dwellEstimate = (model: Model, stop: string, type: number) => {
  const all = pooled(model.dwells[stop])
  return all ? shrink(model.dwells[stop][type], alone(all, DWELL_SIGMA, KAPPA), KAPPA) : undefined
}

/** How likely a bus early at a stop is to wait there for its scheduled time, starting from what the timetable says */
export const holdProbability = (model: Model, route: string, stop: string, isTimepoint: boolean) => {
  const [held, left] = model.holds[`${route}@${stop}`] ?? [0, 0]
  const [a, b] = isTimepoint ? TIMEPOINT_PRIOR : OTHER_PRIOR
  return (held + a) / (held + left + a + b)
}

const heldCache = new WeakMap<Model, WeakMap<Trip, boolean[]>>()

/** Whether a trip's bus waits at each of its stops for its scheduled time when it's early */
export const heldPositions = (model: Model, feed: FeedData, trip: Trip) => {
  let byTrip = heldCache.get(model)
  if (!byTrip)
    heldCache.set(model, byTrip = new WeakMap())
  let held = byTrip.get(trip)
  if (!held)
    byTrip.set(trip, held = trip.stops.map((stop, position) =>
      holdProbability(model, trip.route, feed.stops[stop].id, trip.timepoints.includes(position)) > 0.5
    ))
  return held
}

/** log s a route's buses lay over between trips */
export const layoverEstimate = (model: Model, route: string) => {
  const cell = model.layovers[route]
  return cell && alone(cell, LAYOVER_SIGMA, KAPPA)
}

/** s a bus leaves a stop after its scheduled time on a day type: from that stop, else the route */
export const deviationEstimate = (model: Model, route: string, stop: string, type: number) => {
  const routeLevel = model.deviations[route]?.[type]
  return routeLevel ? shrink(model.deviations[`${route}@${stop}`]?.[type], alone(routeLevel, DEVIATION_SIGMA, KAPPA), KAPPA) : undefined
}

/** The standard normal quantile, to within 5e-4 (Abramowitz and Stegun 26.2.23) */
export const probit = (p: number): number => {
  if (p === 0.5)
    return 0
  if (p > 0.5)
    return -probit(1 - p)
  const t = Math.sqrt(-2 * Math.log(p))
  return -(t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t))
}

/** s that a lognormal estimate is under with probability p */
export const quantile = ({ mu, sigma }: Estimate, p: number) =>
  Math.exp(mu + sigma * probit(p))

/** The variance in s² of a lognormal estimate */
export const variance = ({ mu, sigma }: Estimate) =>
  Math.expm1(sigma * sigma) * Math.exp(2 * mu + sigma * sigma)

/** Which of LEADS a forecast some seconds ahead is scored with */
export const leadIndex = (seconds: number) => {
  const i = LEADS.findIndex((minutes, i) => seconds / 60 <= (minutes + (LEADS[i + 1] ?? Infinity)) / 2)
  return i === -1 ? LEADS.length - 1 : i
}

// Fewer forecasts scored than this at a lead say nothing yet
const MIN_SCORED = 20

/**
 * How many times the model's own spread the forecasts actually used turn out to be off by, at a lead: Umo's
 * predictions, or with none scored, the model's own forecasts
 */
export const inflation = (model: Model, lead: number) => {
  const i = leadIndex(lead)
  const tally = [model.scores.umo[i], model.scores.model[i]].find(([n, , expected]) => n >= MIN_SCORED && expected > 0)
  return tally ? tally[1] / tally[2] : 1
}

//#endregion
