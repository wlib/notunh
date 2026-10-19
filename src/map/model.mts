// What weeks of the Worker's samples show of how the buses run, folded together in the nightly build a service
// day at a time: how long each leg between stops a bus visits one after the other takes at each time of day, and
// how its time is spent along the way, how long buses spend at each stop and lay over at the start of a trip, how
// much longer a bus already there still stays, whether buses wait at a stop for its scheduled time, how far off the
// timetable each route runs, and how often its buses come.
// A day's visits make a summary of sums (summarize), and the model is those summaries folded together, each decayed
// by half every HALF_LIFE days, so a new semester takes over within a month, and folding the same summaries with
// another half-life is all a change of it takes. Every estimate leans on a broader one while it has little data of
// its own. Weighing visits by how sure their times are was measured and made no difference worth keeping
// (notunh-model-research/2026-10-19_location/), but a visit last seen still at its stop says nothing of
// how long buses stay there, as its stay was cut short An empty model has no estimates at all, so
// everything using it falls back on the constants it had before there was a model. Held out a day at a time on
// Oct 7 to 19, chaining these along a bus's trip beat Umo by half at every lead to 20 minutes
// (notunh-model-research/2026-10-19_heldout/IMPLEMENTED.md).
// Keys are stop and route ids, which last across timetables, never trip ids, which don't

import * as v from "valibot"
import { type FeedData, type Trip } from "./feed.mts"
import { type Visit, INCOMPLETE } from "./events.mts"
import { foldDay } from "../shared/learn.mts"
import { objectOf } from "../shared/json.mts"
import { groupBy } from "../shared/group.mts"
import { Day, localDay, localHour, weekday } from "../shared/time.mts"
import { probit } from "../shared/normal.mts"

// How many observations a leg's own mean is worth against how long legs that far usually take, and a time of day's
// against the leg's
const LEG_KAPPA = 5
const CONTEXT_KAPPA = 8
// Bounds on what's learned from, each where the data has a gap between two kinds of thing rather than a spread of
// one (notunh-model-research/2026-10-19_probabilistic/). A bus not driven between two stops it visited, off its
// route or lost to its GPS, took longer than MAX_GAP doing something else than driving the leg: such gaps take two
// minutes, or the better part of an hour, and few between. Longer at a stop is out of service, and longer still
// not a visit at all: one stay in 10,000 is over 7 minutes. Further off its timetable, a bus is on another trip
// than the one it's tagged with, as a connector running a lap late on its last lap's tag is
const MAX_GAP = 600      // s
const MAX_ZONE = 900     // s
const MAX_LINGER = 1800  // s
const MAX_OFFSET = 900   // s
// Seconds already at a stop that how much longer it stays is learned from, and how many visits that takes
const LINGERED = [0, 5, 10, 20, 40, 80, 160, 320]
const MIN_LINGERS = 5
// The Beta prior on whether a bus early at a stop waits there, from whether the timetable says it does
const TIMEPOINT_PRIOR: [number, number] = [4, 1]
const OTHER_PRIOR: [number, number] = [1, 4]
// Cells decayed below this are dropped, keeping the model to what's still running
const MIN_N = 0.01
// How many legs' worth a leg's own profile is against every leg's
const PROFILE_KAPPA = 5

/** Minutes ahead that forecasts are scored at, each scoring those nearest it */
export const LEADS = [1, 3, 5, 10, 20, 30, 60]

/** A decayed count, sum, and sum of squares of observations */
export type Cell = [n: number, sum: number, sum2: number]

/** How a way of forecasting did at a lead: a decayed count and the sum of how far off it was, in s */
type Tally = [n: number, error: number]

export type Scores = {
  /** From where the map would have seen the bus, chained along its trip */
  model:    Tally[],
  /** Umo's own predictions */
  umo:      Tally[],
  /** The timetable, shifted by how late its route runs */
  schedule: Tally[],
  /** How many times the chain's standard deviation it was off by, as decayed counts in RATIOS bins, at each lead */
  ratios:   number[][]
}

/** The model as the build writes it, its statistics taken on trust once its version says what shape they're in */
export const Model = v.object({
  version:  v.literal(3),
  through:  v.nullable(Day),
  /** log s from leaving one stop to getting to the next, by "route:from>to" stop ids, by context */
  legs:     objectOf<Record<string, (Cell | null)[]>>(),
  /** Sums of log m and log s over every leg driven a known distance: n, Σx, Σy, Σx², Σxy */
  lengths:  v.array(v.number()),
  /**
   * How a leg's time is spent along it: the count and the sums of the share of its time a bus took to get a quarter,
   * half, and three quarters of the way, by "route:from>to", and over every leg as "*"
   */
  profiles: objectOf<Record<string, number[]>>(),
  /** s at a stop, from getting there to leaving, by zoneKey */
  zones:    objectOf<Record<string, Cell>>(),
  /** How long a bus some while at a stop still stays there, by zoneKey: for each of LINGERED, a count and the sum of s */
  lingers:  objectOf<Record<string, number[]>>(),
  /** Visits arriving early that waited for their scheduled time, and that didn't, by "route@stop" */
  holds:    objectOf<Record<string, [held: number, left: number]>>(),
  /** s leaving after the scheduled time, by route, by day type */
  offsets:  objectOf<Record<string, (Cell | null)[]>>(),
  /** s between one bus leaving a stop and the next of its route's leaving it, by route, by day type and hour */
  headways: objectOf<Record<string, (Cell | null)[]>>(),
  scores:   objectOf<Scores>()
})
export type Model = v.InferOutput<typeof Model>

/** s something takes on average, and its variance */
export type Estimate = { mean: number, variance: number }

/** Bins of how many standard deviations off a forecast was, a quarter of a doubling each, from 1/64 to 64 */
const RATIOS = 48
const ratioBin = (ratio: number) =>
  Math.min(RATIOS - 1, Math.max(0, Math.floor(4 * Math.log2(ratio)) + RATIOS / 2))

const tallies = () =>
  LEADS.map((): Tally => [0, 0])

export const emptyScores = (): Scores =>
  ({ model: tallies(), umo: tallies(), schedule: tallies(), ratios: LEADS.map(() => Array(RATIOS).fill(0)) })

export const emptyModel = (): Model => ({
  version:  3,
  through:  null,
  legs:     {},
  lengths:  [0, 0, 0, 0, 0],
  profiles: {},
  zones:    {},
  lingers:  {},
  holds:    {},
  offsets:  {},
  headways: {},
  scores:   emptyScores()
})

/** A model as stored, or an empty one for anything that isn't one, like one of an older shape */
export const asModel = (value: unknown): Model =>
  v.is(Model, value) ? value : emptyModel()

/** Which of LEADS a forecast some seconds ahead is scored with */
export const leadIndex = (seconds: number) => {
  const i = LEADS.findIndex((minutes, i) => seconds / 60 <= (minutes + (LEADS[i + 1] ?? Infinity)) / 2)
  return i === -1 ? LEADS.length - 1 : i
}

/** A forecast scored at a lead: how far off it was, and by how many of its own standard deviations */
export const scored = (scores: Scores, kind: keyof Omit<Scores, "ratios">, lead: number, off: number, sd?: number) => {
  const i = leadIndex(lead)
  const [n, error] = scores[kind][i]
  scores[kind][i] = [n + 1, error + Math.abs(off)]
  if (sd)
    scores.ratios[i][ratioBin(Math.abs(off) / sd)]++
}

//#region Contexts

/** 0 for weekdays, 1 for weekends */
export const dayType = (day: Day) =>
  weekday(day) >= 5 ? 1 : 0

// Hours past midnight that a service day runs on into, belonging to the day before
const NIGHT_ENDS = 5
// Hours each context of a day covers
const HOURS = 2
/** How many contexts there are: each two hours of the clock, on weekdays and on weekends */
const CONTEXTS = 2 * 24 / HOURS

/** The day type of an epoch second, in its service day in Durham, which runs on past midnight into the night */
export const dayTypeAt = (at: number) =>
  dayType(localDay((at - NIGHT_ENDS * 3600) * 1000))

/** An epoch second's day type and hour of the clock in Durham, as one index */
const hourAt = (at: number) =>
  dayTypeAt(at) * 24 + localHour(at * 1000)

/** The context of an epoch second: its day type, and its two hours of the clock in Durham */
export const contextAt = (at: number) =>
  dayTypeAt(at) * 24 / HOURS + Math.floor(localHour(at * 1000) / HOURS)

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
  const sums = (sums: number[]) => sums[0] * by >= MIN_N ? sums.map(x => x * by) : null
  return {
    ...model,
    legs:    scaledEach(model.legs, cells),
    lengths: model.lengths.map(x => x * by),
    profiles: scaledEach(model.profiles, sums),
    zones:   scaledEach(model.zones, cell => scaled(cell, by)),
    lingers: scaledEach(model.lingers, sums),
    holds:   scaledEach(model.holds, ([held, left]) => (held + left) * by >= MIN_N ? [held * by, left * by] : null),
    offsets: scaledEach(model.offsets, cells),
    headways: scaledEach(model.headways, cells),
    scores: {
      model:    model.scores.model.map(tally => tally.map(x => x * by) as Tally),
      umo:      model.scores.umo.map(tally => tally.map(x => x * by) as Tally),
      schedule: model.scores.schedule.map(tally => tally.map(x => x * by) as Tally),
      ratios:   model.scores.ratios.map(counts => counts.map(x => x * by))
    }
  }
}

const added = (cell: Cell | null | undefined, x: number): Cell => {
  const [n, sum, sum2] = cell ?? [0, 0, 0]
  return [n + 1, sum + x, sum2 + x * x]
}

/** Adds an observation to a record's cell for a context or day type */
const addTo = (record: Record<string, (Cell | null)[]>, key: string, size: number, index: number, x: number) => {
  const cells = record[key] ??= Array.from({ length: size }, () => null)
  cells[index] = added(cells[index], x)
}

/** The key a stop's times are kept by: the stop on its route, or where a trip starts, the route's layover */
const zoneKey = (route: string, stop: string, isFirst: boolean) =>
  isFirst ? `${route}^` : `${route}@${stop}`
// Every stop's, and every layover's, for routes the model knows nothing of yet, and every leg's profile
const ANY_STOP = "@"
const ANY_LAYOVER = "^"
const ANY_LEG = "*"

// Longer between buses at a stop is a gap in service, not a headway, and fewer of them at a time of day say little
const MAX_HEADWAY = 3 * 3600 // s
const MIN_HEADWAYS = 20
const MAX_SHAPE = 10

// A visit this much ahead of its timetable could have waited for it, and one leaving this close to its scheduled
// time did. Waiting is too rare to fit as a likelihood, against leaving as soon as done, as the waits would mix
// away into nothing: 43 of 11,449 visits a minute or more early on Oct 7 to 19
const EARLY = 60 // s
const GRACE = 30 // s

/**
 * What a service day's visits show, and how forecasts did that day, as sums over the day, undecayed, which fold
 * into a model as they are
 */
export const summarize = (visits: readonly Visit[], scores = emptyScores()): Model => {
  const next = emptyModel()
  const linger = (key: string, seconds: number) => {
    const sums = next.lingers[key] ??= Array(2 * LINGERED.length).fill(0)
    LINGERED.forEach((elapsed, i) => {
      if (seconds > elapsed) {
        sums[2 * i]++
        sums[2 * i + 1] += seconds - elapsed
      }
    })
  }
  const profile = (key: string, shares: readonly number[]) => {
    const sums = next.profiles[key] ??= [0, 0, 0, 0]
    sums[0]++
    shares.forEach((share, j) => sums[j + 1] += share)
  }

  const byVehicle = groupBy(visits, visit => visit.vehicle)
  for (const own of byVehicle.values()) {
    own.sort((a, b) => a.arrive - b.arrive)
    own.forEach(({ stop, route, arrive, depart, scheduled, position, from, meters, left, profile: shares, flags = 0 }, i) => {
      // Every leg between stops visited one after the other: driven, or where the bus was lost between them, the
      // time from leaving one to getting to the other, as long as that could have been driving
      const previous = own[i - 1]
      if (from !== undefined && left !== undefined && arrive > left) {
        addTo(next.legs, `${route}:${from}>${stop}`, CONTEXTS, contextAt(arrive), Math.log(arrive - left))
        if (meters! > 0) {
          const [x, y] = [Math.log(meters!), Math.log(arrive - left)]
          next.lengths = [next.lengths[0] + 1, next.lengths[1] + x, next.lengths[2] + y, next.lengths[3] + x * x, next.lengths[4] + x * y]
        }
        if (shares) {
          profile(`${route}:${from}>${stop}`, shares)
          profile(ANY_LEG, shares)
        }
      }
      else if (previous && previous.stop !== stop && !((previous.flags ?? 0) & INCOMPLETE) && arrive - previous.depart < MAX_GAP)
        addTo(next.legs, `${route}:${previous.stop}>${stop}`, CONTEXTS, contextAt(arrive), Math.log(Math.max(1, arrive - previous.depart)))

      // Last seen still there, when it left is unknown
      if (flags & INCOMPLETE)
        return
      const dwell = depart - arrive
      if (dwell >= 0 && dwell < MAX_ZONE && position !== undefined)
        for (const key of [zoneKey(route, stop, position === 0), position === 0 ? ANY_LAYOVER : ANY_STOP])
          next.zones[key] = added(next.zones[key], dwell)
      if (dwell >= 0 && dwell < MAX_LINGER) {
        linger(zoneKey(route, stop, false), dwell)
        if (position !== undefined)
          linger(position === 0 ? zoneKey(route, stop, true) : ANY_STOP, dwell)
      }

      if (scheduled === undefined)
        return
      const isEarly = arrive < scheduled - EARLY
      if (isEarly) {
        const [waited, went] = next.holds[`${route}@${stop}`] ?? [0, 0]
        next.holds[`${route}@${stop}`] = depart < scheduled - GRACE ? [waited, went + 1] : [waited + 1, went]
      }
      if (Math.abs(depart - scheduled) < MAX_OFFSET)
        addTo(next.offsets, route, 2, dayTypeAt(arrive), depart - scheduled)
    })
  }

  // Each bus leaving a stop after another of its route did
  const byStop = groupBy(visits.filter(({ flags = 0 }) => !(flags & INCOMPLETE)), ({ route, stop }) => `${route}@${stop}`)
  for (const own of byStop.values()) {
    own.sort((a, b) => a.depart - b.depart)
    own.forEach(({ route, vehicle, depart }, i) => {
      const previous = own[i - 1]
      if (previous && previous.vehicle !== vehicle && depart - previous.depart < MAX_HEADWAY)
        addTo(next.headways, route, 2 * 24, hourAt(depart), depart - previous.depart)
    })
  }

  next.scores = structuredClone(scores)
  return next
}

/** Two models' sums added together, cell by cell, an empty cell being none */
const merged = <T,>(a: T, b: T): T =>
  a === null || a === undefined ? b :
  b === null || b === undefined ? a :
  typeof a === "number" ? a + (b as number) as T :
  Array.isArray(a) ? a.map((x, i) => merged(x, (b as unknown[])[i])) as T :
  typeof a === "object" ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(key =>
    [key, merged((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])]
  )) as T :
  a

/** A model with a day's summary added, its version and the day it runs through its own */
const plus = (model: Model, summary: Model): Model => {
  const { version, through, ...sums } = model
  const { version: _, through: __, ...more } = summary
  return { version, through, ...merged(sums, more) }
}

/** The model with a day's summary folded in */
export const fold = (model: Model, day: Day, summary: Model) =>
  foldDay(model, day, scale, before => plus(before, summary))

/** The model with a service day's visits folded in, and how forecasts did that day added to its scores */
export const update = (model: Model, day: Day, visits: readonly Visit[], scores = emptyScores()) =>
  fold(model, day, summarize(visits, scores))

//#endregion

//#region Estimates

const mean = ([n, sum]: Cell) =>
  sum / n

const pooled = (cells: readonly (Cell | null)[]) =>
  cells.reduce<Cell | null>((sum, cell) => cell && sum ? [sum[0] + cell[0], sum[1] + cell[1], sum[2] + cell[2]] : cell ?? sum, null)

/** What's derived from a model's legs as a whole: how long legs take by their length, and by the time of day */
type Fitted = {
  /** log s at log m 0, and per log m */
  length?: [number, number],
  /** How much longer than its leg's mean, in log s, legs take in each context */
  contexts: number[]
}

const fits = new WeakMap<Model, Fitted>()

const fitted = (model: Model) => {
  let fit = fits.get(model)
  if (!fit) {
    const [n, x, y, xx, xy] = model.lengths
    const slope = (n * xy - x * y) / (n * xx - x * x)
    const [sums, counts] = [Array(CONTEXTS).fill(0), Array(CONTEXTS).fill(0)]
    for (const cells of Object.values(model.legs)) {
      const legMean = mean(pooled(cells)!)
      cells.forEach((cell, i) => {
        if (cell) {
          sums[i] += cell[1] - cell[0] * legMean
          counts[i] += cell[0]
        }
      })
    }
    fits.set(model, fit = {
      length:   n >= 2 && Number.isFinite(slope) ? [(y - slope * x) / n, slope] : undefined,
      contexts: sums.map((sum, i) => counts[i] ? sum / counts[i] : 0)
    })
  }
  return fit
}

/**
 * Mean log s for a bus to get from leaving one stop to getting to the next, some meters apart, at an epoch
 * second: that leg's own mean, leaning on how long legs that long take while it's seen few buses, shifted by how
 * much slower legs are at that time of day, and by how much this leg is, as far as it's been seen then
 */
export const legMu = (model: Model, route: string, from: string, to: string, meters: number, at: number) => {
  const { length, contexts } = fitted(model)
  const prior = length && length[0] + length[1] * Math.log(Math.max(1, meters))
  const cells = model.legs[`${route}:${from}>${to}`]
  const all = cells && pooled(cells)
  if (!all && prior === undefined)
    return
  const base = !all ? prior! : prior === undefined ? mean(all) : (all[0] * mean(all) + LEG_KAPPA * prior) / (all[0] + LEG_KAPPA)
  const context = contextAt(at)
  const cell = cells?.[context]
  return base + contexts[context] + (cell ? (mean(cell) - base - contexts[context]) * cell[0] / (cell[0] + CONTEXT_KAPPA) : 0)
}

/** Where a bus driving a leg spends its time, before anything's been learned: slower pulling out and in */
const DEFAULT_PROFILE = [0.3, 0.52, 0.74]

/**
 * The share of a leg's time a bus takes to get a quarter, half, and three quarters of the way: the leg's own,
 * leaning on every leg's while it's seen few buses
 */
export const profileEstimate = (model: Model, route: string, from: string, to: string) => {
  const [n, ...sums] = model.profiles[ANY_LEG] ?? [0, 0, 0, 0]
  const prior = n > 0 ? sums.map(sum => sum / n) : DEFAULT_PROFILE
  const [m, ...own] = model.profiles[`${route}:${from}>${to}`] ?? [0, 0, 0, 0]
  return prior.map((share, j) => (own[j] + PROFILE_KAPPA * share) / (m + PROFILE_KAPPA))
}

const estimate = (cell: Cell | undefined): Estimate | undefined =>
  cell && { mean: mean(cell), variance: Math.max(0, cell[2] / cell[0] - mean(cell) ** 2) }

/** s at a stop, none for going straight through, or laying over at the start of a trip: on that route, else at any stop, or any layover */
export const zoneEstimate = (model: Model, route: string, stop: string, isFirst: boolean) =>
  estimate(model.zones[zoneKey(route, stop, isFirst)] ?? model.zones[isFirst ? ANY_LAYOVER : ANY_STOP])

/**
 * s more a bus some seconds into its time at a stop stays there: as buses that long there did at that stop, else
 * at that route's layovers or at any stop
 */
export const lingerEstimate = (model: Model, route: string, stop: string, isFirst: boolean, elapsed: number) => {
  const i = LINGERED.findLastIndex(seconds => seconds <= elapsed)
  for (const key of [zoneKey(route, stop, false), isFirst ? zoneKey(route, stop, true) : ANY_STOP]) {
    const sums = model.lingers[key]
    if (sums && sums[2 * i] >= MIN_LINGERS)
      return sums[2 * i + 1] / sums[2 * i]
  }
}

/** s a route's buses leave after their scheduled time on a day type, and how much that varies */
export const offsetEstimate = (model: Model, route: string, type: number) => {
  const cells = model.offsets[route]
  return estimate(cells?.[type] ?? (cells && pooled(cells)) ?? undefined)
}

/** The regularized lower incomplete gamma function P(k, x), by its series, for the k of headways (2 to 20 or so) */
const gammaP = (k: number, x: number) => {
  if (x <= 0)
    return 0
  let [term, sum] = [1 / k, 1 / k]
  for (let n = 1; n < 500 && term > sum * 1e-10; n++)
    sum += term *= x / (k + n)
  return Math.min(1, sum * Math.exp(-x + k * Math.log(x) - lnGamma(k)))
}

/** ln Γ(x), Lanczos */
const lnGamma = (x: number): number => {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let [y, sum] = [x, 1.000000000190015]
  for (const c of g)
    sum += c / ++y
  return -(x + 5.5) + (x + 0.5) * Math.log(x + 5.5) + Math.log(2.5066282746310005 * sum / x)
}

/**
 * How long until the next of a route's buses leaves a stop, from an epoch second, knowing nothing of where its
 * buses are: buses that come every so often, gamma distributed as they were at that time of day, are next half the
 * time within this, and on average every this often. For a route that runs by headway, not by its timetable, this
 * beat the timetable's next departure by 50 s held out (fitted moments, rather than every headway seen, cost 10 s)
 */
export const waitEstimate = (model: Model, route: string, at: number) => {
  const cell = model.headways[route]?.[hourAt(at)]
  if (!cell || cell[0] < MIN_HEADWAYS)
    return
  const { mean: headway, variance } = estimate(cell)!
  // Buses coming like clockwork are as good as evenly spaced, which the series below would take forever to say
  const spread = Math.max(variance, (headway / MAX_SHAPE) ** 2)
  const [k, theta] = [headway ** 2 / spread, spread / headway]
  // The chance the wait is within w is how much of the time a bus is due within w: E[min(H, w)] / E[H]
  const within = (w: number) => (w * (1 - gammaP(k, w / theta)) + headway * gammaP(k + 1, w / theta)) / headway
  let [low, high] = [0, 4 * headway]
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2
    if (within(middle) < 0.5)
      low = middle
    else
      high = middle
  }
  return { wait: (low + high) / 2, headway }
}

/** How likely a bus early at a stop is to wait there for its scheduled time, starting from what the timetable says */
export const holdProbability = (model: Model, route: string, stop: string, isTimepoint: boolean) => {
  const [held, left] = model.holds[`${route}@${stop}`] ?? [0, 0]
  const [a, b] = isTimepoint ? TIMEPOINT_PRIOR : OTHER_PRIOR
  return (held + a) / (held + left + a + b)
}

const holdCache = new WeakMap<Model, WeakMap<Trip, number[]>>()

/** How likely a trip's bus is to wait at each of its stops for its scheduled time when it's early */
export const holdChances = (model: Model, feed: FeedData, trip: Trip) => {
  let byTrip = holdCache.get(model)
  if (!byTrip)
    holdCache.set(model, byTrip = new WeakMap())
  let chances = byTrip.get(trip)
  if (!chances)
    byTrip.set(trip, chances = trip.stops.map((stop, position) =>
      holdProbability(model, trip.route, feed.stops[stop].id, trip.timepoints.includes(position))
    ))
  return chances
}

/**
 * A bus more likely than not to wait is expected to, for where it's expected to be and when: of waiting or not,
 * whichever is likelier is the time off by the least, at the median
 */
export const isLikely = (chance: number) =>
  chance > 0.5

// Fewer forecasts scored than this at a lead say nothing yet
const MIN_SCORED = 20

/**
 * How many of its own standard deviations a forecast some seconds ahead is off by no more than with probability p,
 * as the model's forecasts at that lead turned out, or with too few of them scored, as a normal one would be
 */
export const bandScale = (model: Model, lead: number, p: number) => {
  if (p <= 0)
    return 0
  const counts = model.scores.ratios[leadIndex(lead)]
  const total = counts.reduce((sum, n) => sum + n, 0)
  if (total < MIN_SCORED)
    return probit((1 + p) / 2)
  let below = 0
  for (let bin = 0; bin < RATIOS; bin++) {
    if (below + counts[bin] >= p * total)
      return 2 ** ((bin - RATIOS / 2 + (p * total - below) / counts[bin]) / 4)
    below += counts[bin]
  }
  return 2 ** (RATIOS / 8)
}

//#endregion
