// What a model says to expect, for forecasting. Every estimate leans on a broader one while it has little data of
// its own. An empty model has no estimates at all, so everything using it falls back on fixed defaults. Held out a
// day at a time on Oct 7 to 19, chaining these along a bus's trip had half Umo's error at every lead up to 20 minutes

import type { FeedData, Trip } from "../feed.mts"
import { type Cell, type Estimate, type Model, ANY_LAYOVER, ANY_LEG, ANY_STOP, CONTEXTS, LINGERED, RATIOS, contextAt, hourAt, leadIndex, zoneKey } from "./model.mts"
import { probit } from "../../shared/normal.mts"

// How many observations a leg's own mean is worth against how long legs that far usually take, and a time of day's
// against the leg's
const LEG_KAPPA = 5
const CONTEXT_KAPPA = 8
// How many visits that long at a stop it takes to learn how much longer buses stay
const MIN_LINGERS = 5
// The Beta prior on whether a bus early at a stop waits there, from whether the timetable says it does
const TIMEPOINT_PRIOR: [number, number] = [4, 1]
const OTHER_PRIOR: [number, number] = [1, 4]
// How many legs' worth a leg's own profile is against every leg's
const PROFILE_KAPPA = 5
// Fewer headways at a time of day say little
const MIN_HEADWAYS = 20
const MAX_SHAPE = 10

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
 * buses are. Headways are gamma distributed with the moments seen at that time of day. `wait` is the median wait,
 * and `headway` the mean time between buses. For a route that runs by headway, not by its timetable, this beat the
 * timetable's next departure by 50 s held out. Fitted moments cost 10 s against using every headway seen
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
 * Whether a bus is expected to wait, for where it's expected to be and when. Of waiting or not, the likelier one is
 * the median, so it's off by the least at the median
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

