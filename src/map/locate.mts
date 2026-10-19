// Where a bus is along its route, and when it got to and left each stop, as distributions rather than points.
// GPS puts a bus within a few meters, but only every 10 to 30 s, so what's uncertain is what it did between fixes,
// and that's what this models. Each fix is matched to a place along one of its route's shapes (an HMM over the
// places it could be, weighed by how far off each is and its heading, and by whether getting there from the place
// before is a plausible drive: Viterbi over a day's fixes, and only what's come so far live). Between two matched
// fixes, the bus drove as buses do: up to a cruising speed and braking to a stop, stopping or not at each stop on
// the way, and dwelling there, or halted somewhere, for however long the time between the fixes leaves, which is
// integrated over a grid of cruising speeds and ways of splitting that time. That gives each stop's arrival and
// departure as quantiles, how likely the bus stopped there, and when it was a quarter, half, and three quarters of
// the way there from the stop before. A bus stopped near a stop is at it: 98 % of stopped fixes are within REACH of
// one. Nothing here knows of trips or the timetable; a passage is of a stop along a shape

import { type Line } from "../geo/lines.mts"
import { angleBetween } from "../geo/projection.mts"
import type { RouteLine } from "./shapes.mts"

/** A fix as it's matched */
export type Observation = {
  /** Epoch seconds the fix was taken */
  at:        number,
  lat:       number,
  lon:       number,
  /** Degrees clockwise from north, which means nothing for a bus barely moving */
  heading?:  number | null,
  kph?:      number | null,
  /** m, the radius it's likely within, where the source says */
  accuracy?: number
}

/** A time as the model has it: the median, and the 10th and 90th percentiles */
export type Spread = { low: number, median: number, high: number }

/** A bus going through a stop along one of its route's lines */
export type Passage = {
  line:     RouteLine,
  /** The stop's index along the line, counting on around a loop: index n is the first stop on the second lap */
  index:    number,
  stop:     string,
  /** Meters along the line, laps and all */
  distance: number,
  /** When it got to the stop, or stopped for it, and when it left */
  arrive:   Spread,
  depart:   Spread,
  /** How likely it stopped there, rather than going straight through */
  dwelled:  number,
  /**
   * Of the time from leaving the stop before to getting here, the share it took to get a quarter, half, and three
   * quarters of the way, where it was followed all that way
   */
  profile?: number[],
  /** It got there, or left, more than GAP from a fix, so that's when it likely did, not when it was seen to */
  isGap:    boolean,
  /** It was last seen still there, so when it left is unknown, and depart is when it was last seen */
  isIncomplete: boolean
}

/** What a bus is doing: driving, at a stop, or stopped somewhere else, as at lights or behind traffic */
export type Mode = "moving" | "dwelling" | "halted"

/** Where a bus is as of its last fix */
export type Location = {
  line:     RouteLine,
  /** Meters along the line, laps and all, and how far off that may be */
  distance: number,
  sd:       number,
  /** m/s */
  speed:    number,
  mode:     Mode,
  /** Epoch seconds it's been doing that since, as best known */
  since:    number,
  /** Epoch seconds of the fix */
  at:       number,
  /** The stop it's at, or last went through, with when it got there, and when it left, unless it's still there */
  last?:    { stop: string, index: number, distance: number, arrive: number, depart?: number }
}

/** How buses are expected to drive, which a caller who has learned it can say, by a line and a stop's index along it */
export type Expectations = {
  /** m/s a bus drives at between stops index - 1 and index */
  cruise: (line: RouteLine, index: number) => number,
  /** Median s a bus stopping there stays */
  dwell:  (line: RouteLine, index: number) => number,
  /** How likely a bus is to stop there */
  stops:  (line: RouteLine, index: number) => number
}

// How fast buses usually drive between stops, and how much that varies, in log m/s
const CRUISE = 9
const CRUISE_SPREAD = 0.45
// m/s² a bus speeds up and slows down by
const ACCELERATION = 0.8
const BRAKING = 1
// How long a bus stopping at a stop stays, and one halted elsewhere, median s and log spread, and how much longer,
// on average, it's held up on the way between fixes
const DWELL = 15
const HALT = 10
const STAY_SPREAD = 0.9
const DELAY = 4
const STOP_CHANCE = 0.5
// How far off the time between two fixes is, in s, from their whole seconds and where along the street they put
// the bus, which with every other fix left out puts 79 % of arrivals and 90 % of departures inside the 80 % band
// the fixes either side of it give; and how far off a fix's place is, in m, at least and per m/s
const TIME_SIGMA = 2.5
const FIX_SIGMA = 5
const FIX_SIGMA_PER_SPEED = 0.3
// Headings mean something moving at least this fast, and are off by about this many degrees, or are wild
const MOVING_KPH = 5
const HEADING_SIGMA = 25
const WILD_HEADING = 0.02
// Slower is stopped, and a bus stopped this near a stop is at it
const STILL_KPH = 3
export const REACH = 20 // m
// A fix further than this from every line isn't on the route, and a line this much further from it than it was
// has passed it
const SNAP = 60   // m
const PASSED = 15 // m
// GPS wanders this far back along a street, a bus gets no faster, and the drive between fixes is about as long as
// their speeds say, give or take this, and this share of it
const BACK = 30       // m
const MAX_SPEED = 35  // m/s
const SLACK = 20      // m
const SLACK_SHARE = 0.5
// What switching to another of the route's shapes is worth, in log odds
const SWITCH = 8
// Longer between fixes starts a new track, and longer than GAP leaves what happened in between a guess
export const MAX_SILENCE = 300 // s
export const GAP = 60          // s
// The grid integrated over: cruising speeds, and samples of each way of splitting the time between fixes
const SPEEDS = 16
const SPLITS = 8
// Stops between two fixes past which only one of them is thought stopped at
const MAX_STOPS = 3

export const GENERIC: Expectations = { cruise: () => CRUISE, dwell: () => DWELL, stops: () => STOP_CHANCE }

//#region Small numerics

/** Mulberry32, seeded, so the same fixes always give the same passages */
const random = (seed: number) => () => {
  seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

/** The standard normal's cumulative distribution, to 1.5e-7 (Abramowitz and Stegun 7.1.26) */
const phi = (z: number) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z / 2)
  return z >= 0 ? 1 - erfc / 2 : erfc / 2
}

/** The standard normal quantile, by bisection of phi, which is only needed for a fixed grid */
const quantileZ = (p: number) => {
  let [low, high] = [-8, 8]
  for (let i = 0; i < 60; i++) {
    const middle = (low + high) / 2
    if (phi(middle) < p)
      low = middle
    else
      high = middle
  }
  return (low + high) / 2
}

const SPEED_GRID = Array.from({ length: SPEEDS }, (_, i) => quantileZ((i + 0.5) / SPEEDS))

/** How long something stays, log-normally, with a median and a spread: its density, survival, and mean */
const stay = (median: number, spread = STAY_SPREAD) => {
  const mu = Math.log(median)
  return {
    density:  (x: number) => x <= 0 ? 0 : Math.exp(-0.5 * ((Math.log(x) - mu) / spread) ** 2) / (x * spread * Math.sqrt(2 * Math.PI)),
    survival: (x: number) => x <= 0 ? 1 : 1 - phi((Math.log(x) - mu) / spread),
    mean:     median * Math.exp(spread * spread / 2)
  }
}

const factorial = (n: number) => {
  let product = 1
  for (let i = 2; i <= n; i++)
    product *= i
  return product
}

/** The weighted quantile of some values */
const quantile = (values: readonly number[], weights: readonly number[], total: number, p: number) => {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b])
  let below = 0
  for (const i of order) {
    below += weights[i]
    if (below >= p * total)
      return values[i]
  }
  return values[order.at(-1)!]
}

const spreadOf = (values: readonly number[], weights: readonly number[]): Spread => {
  const total = weights.reduce((sum, w) => sum + w, 0)
  return { low: quantile(values, weights, total, 0.1), median: quantile(values, weights, total, 0.5), high: quantile(values, weights, total, 0.9) }
}

const exactly = (time: number): Spread =>
  ({ low: time, median: time, high: time })

//#endregion

//#region Driving

/**
 * Driving some meters from one speed to another, getting up to a cruising speed if there's room: how long it
 * takes, and how long it takes to get some way along
 */
export const drive = (meters: number, from: number, to: number, cruise: number) => {
  // Meters to get from one speed to another, speeding up or braking
  const between = (v: number, w: number) =>
    w >= v ? (w * w - v * v) / (2 * ACCELERATION) : (v * v - w * w) / (2 * BRAKING)
  // As fast as it gets, which is the cruising speed, unless there's not the room to get to it and back
  let peak = Math.max(cruise, 0.1)
  if (between(from, peak) + between(peak, to) > meters)
    peak = Math.max(from, to, Math.sqrt((meters + from * from / (2 * ACCELERATION) + to * to / (2 * BRAKING)) / (1 / (2 * ACCELERATION) + 1 / (2 * BRAKING))))
  const first = Math.min(meters, between(from, peak))
  const last = Math.min(meters - first, between(peak, to))
  const middle = meters - first - last
  // Steady acceleration from a speed across some meters, which a bus braking too hard to cover stops short of
  const across = (v: number, a: number, x: number) =>
    Math.abs(a) < 1e-9 ? x / Math.max(v, 0.1) : (Math.sqrt(Math.max(0, v * v + 2 * a * x)) - v) / a
  const [a1, a3] = [peak >= from ? ACCELERATION : -BRAKING, to >= peak ? ACCELERATION : -BRAKING]
  const [t1, t2] = [across(from, a1, first), middle / peak]
  return {
    time: t1 + t2 + across(peak, a3, last),
    timeTo: (x: number) =>
      x <= first ? across(from, a1, x) :
      x <= first + middle ? t1 + (x - first) / peak :
      t1 + t2 + across(peak, a3, Math.min(last, x - first - middle))
  }
}

/** The cruising speed that covers some meters from one speed to another in some seconds, as near as it can */
const cruiseFor = (meters: number, from: number, to: number, seconds: number) => {
  let [low, high] = [0.5, MAX_SPEED]
  for (let i = 0; i < 40; i++) {
    const middle = (low + high) / 2
    if (drive(meters, from, to, middle).time > seconds)
      low = middle
    else
      high = middle
  }
  return (low + high) / 2
}

//#endregion

//#region Stops along lines

/** Meters along a line of the stop at an index counting on around a loop, or ±Infinity off either end of one that isn't */
export const stopDistance = (line: RouteLine, index: number) => {
  const n = line.stops.length
  if (!line.isLoop && (index < 0 || index >= n) || !n)
    return index < 0 ? -Infinity : Infinity
  const lap = Math.floor(index / n)
  return line.stops[index - lap * n].distance + lap * line.length
}

export const stopId = (line: RouteLine, index: number) =>
  line.stops[((index % line.stops.length) + line.stops.length) % line.stops.length].id

/** The index of the first stop past a distance along a line, counting on around a loop */
export const stopAhead = (line: RouteLine, distance: number) => {
  const n = line.stops.length
  const lap = line.isLoop ? Math.floor(distance / line.length) : 0
  const offset = distance - lap * line.length
  let [low, high] = [0, n]
  while (low < high) {
    const middle = (low + high) >> 1
    if (line.stops[middle].distance > offset)
      high = middle
    else
      low = middle + 1
  }
  return lap * n + low
}

//#endregion

//#region Matching fixes to lines

/** A place along a line a fix could be, how far off it, and which way the line goes there */
type Candidate = { line: number, distance: number, meters: number, bearing: number }

/**
 * Where along each line a fix could be: the nearest point of each pass the line makes by it within SNAP, a pass
 * ending where the line goes off further than SNAP, or turns back and comes by again
 */
const candidates = (lines: readonly Line[], { lat, lon }: Observation) => {
  const found: Candidate[] = []
  lines.forEach((line, index) => {
    const { coordinates, distances, ruler: { kx, ky } } = line
    let best: Candidate | undefined
    let previous = Infinity
    for (let i = 0; i + 1 < coordinates.length; i++) {
      const [a, b] = [coordinates[i], coordinates[i + 1]]
      const [px, py, dx, dy] = [(lon - a[0]) * kx, (lat - a[1]) * ky, (b[0] - a[0]) * kx, (b[1] - a[1]) * ky]
      const t = dx || dy ? Math.min(1, Math.max(0, (px * dx + py * dy) / (dx * dx + dy * dy))) : 0
      const meters = Math.hypot(px - t * dx, py - t * dy)
      if (best && (meters > SNAP || meters > best.meters + PASSED)) {
        found.push(best)
        best = undefined
      }
      // Nearing the fix, after going off from it
      if (meters <= SNAP && (best ? meters < best.meters : meters <= previous))
        best = { line: index, distance: distances[i] + t * (distances[i + 1] - distances[i]), meters, bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 }
      previous = meters
    }
    if (best)
      found.push(best)
  })
  return found
}

const speedOf = (fix: Observation) =>
  Math.max(0, (fix.kph ?? 0) / 3.6)

const isStill = (fix: Observation) =>
  (fix.kph ?? Infinity) <= STILL_KPH

const sigmaOf = (fix: Observation) =>
  Math.max(fix.accuracy ?? 0, FIX_SIGMA + FIX_SIGMA_PER_SPEED * speedOf(fix))

/** Log odds of a fix being at a candidate, from how far off it is, and its heading */
const emission = (fix: Observation, { meters, bearing }: Candidate) => {
  const isHeaded = fix.heading != null && (fix.kph ?? 0) >= MOVING_KPH
  return -0.5 * (meters / sigmaOf(fix)) ** 2 +
    (isHeaded ? Math.log(Math.exp(-0.5 * (angleBetween(fix.heading!, bearing) / HEADING_SIGMA) ** 2) + WILD_HEADING) : 0)
}

/** A fix matched to a line, laps and all */
type Matched = { fix: Observation, line: number, distance: number }

/**
 * Log odds of driving from a matched fix to a candidate for the next, and how far along that is, laps and all:
 * about as far as their speeds say, never far back, and never faster than a bus goes. Switching lines is a new track
 */
const transition = (lines: readonly RouteLine[], from: Matched, fix: Observation, to: Candidate) => {
  if (to.line !== from.line)
    return { log: -SWITCH, distance: to.distance, isNew: true }
  const line = lines[to.line]
  let moved = to.distance - (line.isLoop ? from.distance - Math.floor(from.distance / line.length) * line.length : from.distance)
  if (line.isLoop) {
    moved = ((moved % line.length) + line.length) % line.length
    if (moved > line.length - BACK)
      moved -= line.length
  }
  const seconds = fix.at - from.fix.at
  const expected = (speedOf(from.fix) + speedOf(fix)) / 2 * seconds
  const log = moved < -BACK || moved > MAX_SPEED * seconds + SLACK
    ? -Infinity
    : -Math.abs(moved - expected) / (SLACK + SLACK_SHARE * expected)
  return { log, distance: from.distance + moved, isNew: false }
}

/**
 * The likeliest places along some lines for a bus's fixes in order, as tracks, each on one line, between which it
 * was lost, off the route, silent too long, or switched to another line (Viterbi)
 */
export const match = (lines: readonly RouteLine[], fixes: readonly Observation[]) => {
  const tracks: Matched[][] = []
  // Each run of fixes on the route, without a silence, matched as a whole
  let run: { fix: Observation, options: Candidate[] }[] = []
  const flush = () => {
    if (!run.length)
      return
    // For each fix, the best way to each of its candidates, laps and all, and where from
    const steps: { score: number, distance: number, from: number, isNew: boolean }[][] = [
      run[0].options.map(option => ({ score: emission(run[0].fix, option), distance: option.distance, from: -1, isNew: true }))
    ]
    for (let k = 1; k < run.length; k++) {
      const { fix, options } = run[k]
      const before = steps[k - 1]
      const restart = Math.max(...before.map(step => step.score)) - 2 * SWITCH
      steps.push(options.map(option => {
        // Nowhere it could have driven from, a track starts here
        let best = { score: restart, distance: option.distance, from: before.reduce((top, step, j) => step.score > before[top].score ? j : top, 0), isNew: true }
        before.forEach((previous, j) => {
          const step = transition(lines, { fix: run[k - 1].fix, line: run[k - 1].options[j].line, distance: previous.distance }, fix, option)
          if (previous.score + step.log > best.score)
            best = { score: previous.score + step.log, distance: step.distance, from: j, isNew: step.isNew }
        })
        return { ...best, score: best.score + emission(fix, option) }
      }))
    }
    // Back from the best last
    const path: (Matched & { isNew: boolean })[] = []
    let j = steps.at(-1)!.reduce((top, step, i, all) => step.score > all[top].score ? i : top, 0)
    for (let k = run.length - 1; k >= 0; k--) {
      const step = steps[k][j]
      path.push({ fix: run[k].fix, line: run[k].options[j].line, distance: step.distance, isNew: step.isNew })
      j = step.from
    }
    for (const { isNew, ...point } of path.reverse()) {
      if (isNew)
        tracks.push([])
      tracks.at(-1)!.push(point)
    }
    run = []
  }
  for (const fix of fixes) {
    if (run.length && fix.at <= run.at(-1)!.fix.at)
      continue
    const options = candidates(lines, fix)
    if (!options.length || (run.length && fix.at - run.at(-1)!.fix.at > MAX_SILENCE))
      flush()
    if (options.length)
      run.push({ fix, options })
  }
  flush()
  return tracks
}

//#endregion

//#region Between fixes

/** A stop a bus is at, by index, when it got there, and its way there from the stop before, when known */
type At = { index: number, arrive: Spread, isGap: boolean, profile?: number[] }

/** What's known of a bus's track as of its last matched fix */
type State = {
  line:     RouteLine,
  last:     Matched,
  /** The first stop it hasn't been through */
  ahead:    number,
  /** The stop it's at */
  at?:      At,
  /** The stop it last left, and when, and when it got each quarter of the way to the next */
  left?:    { index: number, at: number },
  quarters: number[],
  /** Since when it's been stopped where there's no stop */
  halted?:  number,
  /** The stop it last went through */
  passed?:  Passage
}

/** The stop a fix stopped near a stop is at, of those it hasn't been through, or the one it's at */
const stopAt = (state: State, point: Matched) => {
  if (!isStill(point.fix))
    return
  const { line } = state
  const ahead = stopAhead(line, point.distance)
  for (const index of [ahead - 1, ahead])
    if (index >= (state.at?.index ?? state.ahead) && Math.abs(stopDistance(line, index) - point.distance) <= REACH)
      return index
}

type Sample = {
  weight:   number,
  /** When it left the stop it was at */
  depart?:  number,
  /** When it got to and left each stop between */
  stops:    { arrive: number, depart: number, dwelled: boolean }[],
  /** When it got to the stop it's at */
  arrive?:  number,
  quarters: number[]
}

/**
 * What a bus did between two matched fixes on one line, integrated over how fast it cruised, which stops between
 * them it stopped at, and how the time left over from driving splits between staying on at the stop it was at, at
 * those it stopped at, at the stop it's at, and being held up on the way. Gives back the passages it finished, and
 * moves the state on to the second fix
 */
const between = (state: State, to: Matched, expect: Expectations): Passage[] => {
  const { line, last: from } = state
  const toAt = stopAt(state, to)
  // Still at the stop it was at
  if (state.at && toAt === state.at.index) {
    state.last = to
    return []
  }
  const t0 = from.fix.at
  const seconds = to.fix.at - t0
  const start = state.at ? stopDistance(line, state.at.index) : from.distance
  const end = Math.max(start, toAt === undefined ? to.distance : stopDistance(line, toAt))
  const [v0, v1] = [state.at ? 0 : speedOf(from.fix), toAt === undefined ? speedOf(to.fix) : 0]
  // The stops between, which it stopped at or went through
  const first = state.at ? state.at.index + 1 : state.ahead
  const inside: number[] = []
  for (let index = first; toAt === undefined ? stopDistance(line, index) <= end : index < toAt; index++)
    inside.push(index)
  // Each quarter of the way between stops that it drove through
  const quarterPoints: { leg: number, j: number, distance: number }[] = []
  for (let leg = first; leg <= (toAt ?? stopAhead(line, end)); leg++) {
    const [a, b] = [stopDistance(line, leg - 1), stopDistance(line, leg)]
    if (Number.isFinite(a) && Number.isFinite(b))
      for (let j = 0; j < 3; j++) {
        const distance = a + (j + 1) / 4 * (b - a)
        if (distance > start && distance <= end)
          quarterPoints.push({ leg, j, distance })
      }
  }

  const wasStill = isStill(from.fix) && !state.at
  const isStillNow = isStill(to.fix) && toAt === undefined
  const isGap = seconds > GAP
  const passages: Passage[] = []
  const finish = (index: number, arrive: Spread, depart: Spread, dwelled: number, wasGap: boolean, profile?: number[]): Passage => ({
    line, index, stop: stopId(line, index), distance: stopDistance(line, index),
    arrive, depart, dwelled, ...profile && { profile }, isGap: wasGap, isIncomplete: false
  })
  /** The profile of the way to a stop, from the quarters, given when it got there */
  const profileTo = (index: number, arrive: number) => {
    const { left, quarters } = state
    if (left?.index !== index - 1 || [0, 1, 2].some(j => !Number.isFinite(quarters[j])))
      return
    const shares = quarters.map(time => (time - left.at) / (arrive - left.at))
    return arrive > left.at && shares.every((share, j) => share >= 0 && share <= 1 && (!j || share >= shares[j - 1])) ? shares : undefined
  }

  if (!state.at && toAt === undefined && !inside.length) {
    // Nothing happened at a stop: it drove as its speeds say, which times the quarters
    const piece = drive(end - start, v0, v1, cruiseFor(end - start, v0, v1, seconds))
    const stretch = seconds / Math.max(piece.time, 1e-9)
    for (const point of quarterPoints)
      state.quarters[point.j] = t0 + piece.timeTo(point.distance - start) * stretch
  }
  else {
    const samples = sample(state, { start, end, v0, v1, seconds, inside, toAt, wasStill, isStillNow, quarterPoints }, expect)
    const total = samples.reduce((sum, { weight }) => sum + weight, 0)
    // Nothing fits, as with a bus further on than it could have driven: times are spread evenly across the gap
    const timeAlong = (distance: number) => t0 + (end > start ? (distance - start) / (end - start) : 0) * seconds
    const spreadAt = (pick: (sample: Sample) => number | undefined, fallback: number) => {
      const timed = total > 0 ? samples.filter(sample => pick(sample) !== undefined) : []
      return timed.length ? spreadOf(timed.map(sample => pick(sample)!), timed.map(({ weight }) => weight)) : exactly(fallback)
    }
    let quarter = 0
    const quartersTo = (leg: number) => {
      for (; quarter < quarterPoints.length && quarterPoints[quarter].leg <= leg; quarter++)
        state.quarters[quarterPoints[quarter].j] = total > 0
          ? samples.reduce((sum, sample) => sum + sample.weight * sample.quarters[quarter], 0) / total
          : timeAlong(quarterPoints[quarter].distance)
    }

    if (state.at) {
      const depart = spreadAt(sample => sample.depart, t0)
      passages.push(finish(state.at.index, state.at.arrive, depart, 1, state.at.isGap || isGap, state.at.profile))
      state.left = { index: state.at.index, at: depart.median }
      state.quarters = []
      state.at = undefined
    }
    inside.forEach((index, s) => {
      quartersTo(index)
      const arrive = spreadAt(sample => sample.stops[s]?.arrive, timeAlong(stopDistance(line, index)))
      const depart = spreadAt(sample => sample.stops[s]?.depart, timeAlong(stopDistance(line, index)))
      const dwelled = total > 0 ? samples.reduce((sum, sample) => sum + (sample.stops[s]?.dwelled ? sample.weight : 0), 0) / total : 0
      passages.push(finish(index, arrive, depart, dwelled, isGap, profileTo(index, arrive.median)))
      state.left = { index, at: depart.median }
      state.quarters = []
    })
    if (toAt !== undefined) {
      quartersTo(toAt)
      const arrive = spreadAt(sample => sample.arrive, to.fix.at)
      state.at = { index: toAt, arrive, isGap, ...profileOf(profileTo(toAt, arrive.median)) }
      state.quarters = []
    }
    quartersTo(Infinity)
  }

  state.halted = isStillNow ? (wasStill ? state.halted : (t0 + to.fix.at) / 2) : undefined
  state.ahead = toAt !== undefined ? toAt + 1 : Math.max(state.ahead, stopAhead(line, end), first + inside.length)
  if (passages.length)
    state.passed = passages.at(-1)
  state.last = { ...to, distance: Math.max(to.distance, start) }
  return passages
}

const profileOf = (profile: number[] | undefined) =>
  profile ? { profile } : {}

/**
 * Weighted samples of what a bus did between two fixes: for each cruising speed of a grid, and each choice of which
 * stops between it stopped at, SPLITS ways of splitting the time it didn't spend driving between the stops it
 * stopped at, the stop it was at or the place it was halted at, the one it's at or the place it's halted at, and
 * delays on the way, weighed by how likely each is
 */
const sample = (
  state: State,
  { start, end, v0, v1, seconds, inside, toAt, wasStill, isStillNow, quarterPoints }: {
    start: number, end: number, v0: number, v1: number, seconds: number, inside: number[], toAt: number | undefined,
    wasStill: boolean, isStillNow: boolean, quarterPoints: { distance: number }[]
  },
  expect: Expectations
) => {
  const { line, at } = state
  const t0 = state.last.fix.at
  const rand = random(Math.floor(t0 * 10) ^ Math.floor(start))
  const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())

  // Which of the stops between it stopped at: every way, or across a gap past many, at most one of them
  const k = inside.length
  const choices = k <= MAX_STOPS
    ? Array.from({ length: 1 << k }, (_, mask) => inside.map((_, i) => Boolean(mask >> i & 1)))
    : [-1, ...inside.keys()].map(stopped => inside.map((_, i) => i === stopped))
  const dwells = inside.map(index => stay(expect.dwell(line, index)))
  const leaving = at && stay(expect.dwell(line, at.index))
  const arriving = toAt !== undefined ? stay(expect.dwell(line, toAt)) : undefined
  const halts = stay(HALT)
  const cruise = expect.cruise(line, inside[0] ?? toAt ?? stopAhead(line, end))

  const samples: Sample[] = []
  for (const z of SPEED_GRID) {
    const c = cruise * Math.exp(CRUISE_SPREAD * z)
    for (const stops of choices) {
      const prior = inside.reduce((p, index, i) => p * (stops[i] ? expect.stops(line, index) : 1 - expect.stops(line, index)), 1)
      if (!prior)
        continue
      // Its drive, from where it was to each stop it stopped at and on to where it is
      const stoppedAt = inside.filter((_, i) => stops[i])
      const ends = [...stoppedAt.map(index => stopDistance(line, index)), end]
      const pieces = ends.map((distance, i) => {
        const begin = i ? ends[i - 1] : start
        return { begin, distance, ...drive(distance - begin, i ? 0 : v0, i === ends.length - 1 ? v1 : 0, c) }
      })
      const driving = pieces.reduce((sum, piece) => sum + piece.time, 0)
      const slots = (at || wasStill ? 1 : 0) + stoppedAt.length + (toAt !== undefined || isStillNow ? 1 : 0)
      for (let split = 0; split < SPLITS; split++) {
        const left = seconds + TIME_SIGMA * normal() - driving
        if (left < 0)
          continue
        // A uniform split of what's left between the slots and delays on the way, and its density
        const cuts = Array.from({ length: slots }, () => rand() * left).sort((a, b) => a - b)
        const shares = [...cuts, left].map((cut, i) => cut - (i ? cuts[i - 1] : 0))
        const delay = shares.pop()!
        let weight = prior * Math.exp(-delay / DELAY) / DELAY * left ** slots / factorial(slots)
        let slot = 0
        let time = t0
        const sample: Sample = { weight: 0, stops: [], quarters: [] }
        if (at) {
          // Staying on at the stop it was at, having been there a while
          const elapsed = Math.max(0, t0 - at.arrive.median)
          weight *= leaving!.density(elapsed + shares[slot]) / Math.max(1e-9, leaving!.survival(elapsed))
          time += shares[slot++]
          sample.depart = time
        }
        else if (wasStill) {
          const elapsed = Math.max(0, t0 - (state.halted ?? t0))
          weight *= halts.density(elapsed + shares[slot]) / Math.max(1e-9, halts.survival(elapsed))
          time += shares[slot++]
        }
        const stretch = 1 + delay / Math.max(driving, 1e-9)
        pieces.forEach((piece, i) => {
          const through = (distance: number) => distance > piece.begin && distance <= piece.distance
          inside.forEach((index, s) => {
            if (!stops[s] && through(stopDistance(line, index))) {
              const passing = time + piece.timeTo(stopDistance(line, index) - piece.begin) * stretch
              sample.stops[s] = { arrive: passing, depart: passing, dwelled: false }
            }
          })
          quarterPoints.forEach((point, q) => {
            if (through(point.distance))
              sample.quarters[q] = time + piece.timeTo(point.distance - piece.begin) * stretch
          })
          time += piece.time * stretch
          if (i < stoppedAt.length) {
            const s = inside.indexOf(stoppedAt[i])
            const dwell = shares[slot++]
            weight *= dwells[s].density(dwell)
            sample.stops[s] = { arrive: time, depart: time + dwell, dwelled: true }
            time += dwell
          }
        })
        // Got to the stop it's at, and there since, or halted since
        if (toAt !== undefined) {
          weight *= arriving!.survival(shares[slot]) / arriving!.mean
          sample.arrive = time
        }
        else if (isStillNow)
          weight *= halts.survival(shares[slot]) / halts.mean
        sample.weight = weight
        if (weight > 0 && Number.isFinite(weight))
          samples.push(sample)
      }
    }
  }
  return samples
}

//#endregion

/**
 * Follows one bus along its route's lines, a matched fix at a time, as the nightly extraction does along a day's
 * tracks and the map does live: each fix gives back the passages it finished, and ending a track gives back the stop
 * it was last at, if it was at one, as incomplete
 */
const tracker = (lines: readonly RouteLine[], expect: Expectations) => {
  let state: State | undefined

  const end = (): Passage[] => {
    const at = state?.at
    const ended = at ? [{
      line: state!.line, index: at.index, stop: stopId(state!.line, at.index), distance: stopDistance(state!.line, at.index),
      arrive: at.arrive, depart: exactly(state!.last.fix.at), dwelled: 1, ...profileOf(at.profile), isGap: at.isGap, isIncomplete: true
    }] : []
    state = undefined
    return ended
  }

  const push = (point: Matched, isNew: boolean): Passage[] => {
    const ended = isNew ? end() : []
    if (!state) {
      const line = lines[point.line]
      state = { line, last: point, ahead: stopAhead(line, point.distance), quarters: [] }
      // Already at a stop when first seen, it's not known when it got there, so that stop is left out
      const at = stopAt(state, point)
      if (at !== undefined)
        state.ahead = at + 1
      else if (isStill(point.fix))
        state.halted = point.fix.at
      return ended
    }
    return [...ended, ...between(state, point, expect)]
  }

  const location = (): Location | undefined => {
    if (!state)
      return
    const { line, last, at, halted, passed } = state
    return {
      line,
      distance: at ? stopDistance(line, at.index) : last.distance,
      sd:       sigmaOf(last.fix),
      speed:    at ? 0 : speedOf(last.fix),
      mode:     at ? "dwelling" : halted !== undefined ? "halted" : "moving",
      since:    at ? at.arrive.median : halted ?? passed?.depart.median ?? last.fix.at,
      at:       last.fix.at,
      ...at
        ? { last: { stop: stopId(line, at.index), index: at.index, distance: stopDistance(line, at.index), arrive: at.arrive.median } }
        : passed && { last: { stop: passed.stop, index: passed.index, distance: passed.distance, arrive: passed.arrive.median, depart: passed.depart.median } }
    }
  }

  return { push, end, location }
}

/** Every passage a bus's fixes show, matched as a whole, as the nightly extraction reads them: in order, by track */
export const passagesOf = (lines: readonly RouteLine[], fixes: readonly Observation[], expect = GENERIC) => {
  const follow = tracker(lines, expect)
  return match(lines, fixes).map(track => [
    ...track.flatMap((point, k) => follow.push(point, k === 0)),
    ...follow.end()
  ])
}

/**
 * Follows one bus live, a fix at a time, each matched by what's come so far: observe gives back the passages each
 * fix finished, and locate where the bus is as of its last
 */
export const locator = (lines: readonly RouteLine[], expect = GENERIC) => {
  const follow = tracker(lines, expect)
  let last: Matched | undefined

  const observe = (fix: Observation): Passage[] => {
    if (last && fix.at <= last.fix.at)
      return []
    const options = candidates(lines, fix)
    if (!options.length || (last && fix.at - last.fix.at > MAX_SILENCE)) {
      last = undefined
      return follow.end()
    }
    let best: { score: number, point: Matched, isNew: boolean } | undefined
    for (const option of options) {
      const step = last ? transition(lines, last, fix, option) : { log: 0, distance: option.distance, isNew: true }
      const isDriven = Number.isFinite(step.log)
      const score = (isDriven ? step.log : -2 * SWITCH) + emission(fix, option)
      if (!best || score > best.score)
        best = { score, point: { fix, line: option.line, distance: isDriven ? step.distance : option.distance }, isNew: step.isNew || !isDriven }
    }
    last = best!.point
    return follow.push(best!.point, best!.isNew)
  }

  return { observe, finish: () => follow.end(), locate: follow.location }
}
