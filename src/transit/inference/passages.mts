// What a bus did between matched fixes, and so when it got to and left each stop, as distributions rather than
// points. GPS puts a bus within a few meters, but only every 10 to 30 s, so what's uncertain is what it did between
// fixes, and that's what this models.
//
// Between two matched fixes, the bus drove as buses do: up to a cruising speed and braking to a stop, stopping or
// not at each stop on the way. It dwelled at those stops, or halted somewhere, for however long the time between the
// fixes leaves. This is integrated over a grid of cruising speeds and ways of splitting that time. That gives each
// stop's arrival and departure as quantiles, how likely the bus stopped there, and when it was a quarter, half, and
// three quarters of the way there from the stop before. Whether a fix is of a bus at a stop, halted elsewhere, or
// moving is a posterior (likelihoods.mts). Nothing here knows of trips or the timetable: a passage is of a stop along
// a shape

import { cdf, density, probit } from "../../shared/normal.mts"
import { type RouteLine, stopAhead, stopDistance, stopId } from "../shapes.mts"
import { CREEP, isStill, sigmaOf, speedOf, standing } from "./likelihoods.mts"
import { type Matched, MAX_SPEED } from "./matching.mts"

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
  /** It was first seen already there, so when it got there is unknown, and arrive is when it was first seen */
  isJoined:     boolean,
  /** It was last seen still there, so when it left is unknown, and depart is when it was last seen */
  isIncomplete: boolean
}

/** Whether a bus drove to a stop from the one before it went through, so the time between is the leg's */
export const drove = (before: Passage | undefined, passage: Passage): before is Passage =>
  before !== undefined && before.line === passage.line && before.index === passage.index - 1 && !before.isIncomplete

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

// How fast buses usually drive between stops, median m/s, and how much that varies, in log m/s
const CRUISE = 9
const CRUISE_SPREAD = 0.45
// m/s² a bus speeds up and slows down by
const ACCELERATION = 0.8
const BRAKING = 1
// The priors the time between two fixes is integrated over. DWELL and HALT are how long a bus stopping at a stop
// stays and one halted elsewhere, median s, with STAY_SPREAD their log spread. DELAY is the mean s it's held up on
// the way between fixes, and STOP_CHANCE how likely it is to stop at a stop it passes
const DWELL = 15
const HALT = 10
const STAY_SPREAD = 0.9
const DELAY = 4
const STOP_CHANCE = 0.5
// How far off the time between two fixes is, in s, from their whole seconds and where along the street they put
// the bus. With every other fix left out, this puts 79 % of arrivals and 90 % of departures inside the 80 % band
// the fixes either side give
const TIME_SIGMA = 2.5

// These bound the work: the cruising speeds and samples of each way of splitting the time between fixes, and how
// many stops between two fixes each could be stopped at before only one of them is
const SPEEDS = 16
const SPLITS = 8
const MAX_STOPS = 3

export const GENERIC: Expectations = { cruise: () => CRUISE, dwell: () => DWELL, stops: () => STOP_CHANCE }


/** Mulberry32, seeded, so the same fixes always give the same passages */
const random = (seed: number) => () => {
  seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

const SPEED_GRID = Array.from({ length: SPEEDS }, (_, i) => probit((i + 0.5) / SPEEDS))

/** How long something stays, log-normally, with a median and a spread: its density, survival, and mean */
const stay = (median: number, spread = STAY_SPREAD) => {
  const mu = Math.log(median)
  return {
    density:  (x: number) => x <= 0 ? 0 : density((Math.log(x) - mu) / spread) / (x * spread),
    survival: (x: number) => x <= 0 ? 1 : 1 - cdf((Math.log(x) - mu) / spread),
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

/**
 * Driving some meters from one speed to another, getting up to a cruising speed if there's room: how long it
 * takes, and how long it takes to get some way along
 */
export const drive = (meters: number, from: number, to: number, cruise: number) => {
  // Meters to get from one speed to another, speeding up or braking
  const between = (v: number, w: number) =>
    w >= v ? (w * w - v * v) / (2 * ACCELERATION) : (v * v - w * w) / (2 * BRAKING)
  // As fast as it gets, which is the cruising speed, unless there's not the room to get to it and back: then as near
  // to it as the room allows, the top of a rise when it's faster than both ends, the bottom of a dip when slower, and
  // when it's between them, no nearer than where it starts
  let peak = Math.max(cruise, 0.1)
  if (between(from, peak) + between(peak, to) > meters)
    peak =
      peak > Math.max(from, to) ? Math.max(from, to, Math.sqrt((meters + from * from / (2 * ACCELERATION) + to * to / (2 * BRAKING)) / (1 / (2 * ACCELERATION) + 1 / (2 * BRAKING)))) :
      peak < Math.min(from, to) ? Math.min(from, to, Math.sqrt(Math.max(0, (from * from / (2 * BRAKING) + to * to / (2 * ACCELERATION) - meters) / (1 / (2 * BRAKING) + 1 / (2 * ACCELERATION))))) :
      from
  const first = Math.min(meters, between(from, peak))
  const last = Math.min(meters - first, between(peak, to))
  const middle = meters - first - last
  // Steady acceleration from a speed across some meters, which a bus braking too hard to cover stops short of
  const across = (v: number, a: number, x: number) =>
    Math.abs(a) < 1e-9 ? x / Math.max(v, 0.1) : (Math.sqrt(Math.max(0, v * v + 2 * a * x)) - v) / a
  const [a1, a3] = [peak >= from ? ACCELERATION : -BRAKING, to >= peak ? ACCELERATION : -BRAKING]
  const [t1, t2] = [across(from, a1, first), middle > 0 ? middle / peak : 0]
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

/**
 * A stop a bus is at, by index, how likely its fixes there say it is to be standing at it, when it got there, or was
 * first seen there, and its way there from the stop before, when known
 */
type At = { index: number, chance: number, arrive: Spread, isJoined?: boolean, profile?: number[] }

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

/**
 * The stop a fix is of a bus at, standing or creeping, of those either side of it that it hasn't been through, or
 * the one it's at, where that's likelier than its being halted there, and how likely
 */
const stopAt = (state: State, point: Matched) => {
  const isNear = (point.fix.kph ?? Infinity) <= CREEP
  const ahead = stopAhead(state.line, point.distance)
  let found: { index: number, chance: number } | undefined
  for (const index of [ahead - 1, ahead]) {
    const chance = isNear ? standing(point.distance - stopDistance(state.line, index)) : 0
    if (index >= (state.at?.index ?? state.ahead) && chance > Math.max(0.5, found?.chance ?? 0))
      found = { index, chance }
  }
  return found
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
  const found = stopAt(state, to)
  const toAt = found?.index
  // Still at the stop it was at, which every fix of it there is more evidence of
  if (state.at && toAt === state.at.index) {
    state.at.chance = Math.max(state.at.chance, found!.chance)
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
  const passages: Passage[] = []
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
    // Nothing fits, as with a bus further on than it could have driven: times are spread evenly across the gap, each
    // as likely anywhere in it, as all the fixes say is that it was between them
    const timeAlong = (distance: number) => t0 + (end > start ? (distance - start) / (end - start) : 0) * seconds
    const spreadAt = (pick: (sample: Sample) => number | undefined, fallback: number) => {
      const timed = total > 0 ? samples.filter(sample => pick(sample) !== undefined) : []
      return timed.length ? spreadOf(timed.map(sample => pick(sample)!), timed.map(({ weight }) => weight)) : { low: t0, median: fallback, high: to.fix.at }
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
      const passage = passageOf(line, state.at, depart)
      passages.push(passage)
      state.left = { index: state.at.index, at: passage.depart.median }
      state.quarters = []
      state.at = undefined
    }
    inside.forEach((index, s) => {
      quartersTo(index)
      const arrive = spreadAt(sample => sample.stops[s]?.arrive, timeAlong(stopDistance(line, index)))
      const depart = spreadAt(sample => sample.stops[s]?.depart, timeAlong(stopDistance(line, index)))
      const dwelled = total > 0 ? samples.reduce((sum, sample) => sum + (sample.stops[s]?.dwelled ? sample.weight : 0), 0) / total : 0
      const passage = passageOf(line, { index, chance: dwelled, arrive, profile: profileTo(index, arrive.median) }, depart)
      passages.push(passage)
      state.left = { index, at: passage.depart.median }
      state.quarters = []
    })
    if (toAt !== undefined) {
      quartersTo(toAt)
      const arrive = spreadAt(sample => sample.arrive, to.fix.at)
      state.at = { index: toAt, chance: found!.chance, arrive, profile: profileTo(toAt, arrive.median) }
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

/** A bus's passage through the stop it was at, as it left it, or was last seen there */
// Arrive and depart are each spread over the samples that time them, which needn't be the same ones, so a bus
// leaving soon after it got there could be had leaving before it arrived: it leaves no sooner
const passageOf = (line: RouteLine, { index, chance, arrive, profile, isJoined = false }: At, depart: Spread, isIncomplete = false): Passage => ({
  line, index, stop: stopId(line, index), distance: stopDistance(line, index),
  arrive,
  depart: { low: Math.max(depart.low, arrive.low), median: Math.max(depart.median, arrive.median), high: Math.max(depart.high, arrive.high) },
  dwelled: chance, ...profile && { profile }, isJoined, isIncomplete
})

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

/**
 * Follows one bus along its route's lines, a matched fix at a time, as the nightly extraction does along a day's
 * tracks and the map does live: each fix gives back the passages it finished, and ending a track gives back the stop
 * it was last at, if it was at one, as incomplete
 */
export const tracker = (lines: readonly RouteLine[], expect: Expectations) => {
  let state: State | undefined

  const end = (): Passage[] => {
    const ended = state?.at ? [passageOf(state.line, state.at, exactly(state.last.fix.at), true)] : []
    state = undefined
    return ended
  }

  const push = (point: Matched, isNew: boolean): Passage[] => {
    const ended = isNew ? end() : []
    if (!state) {
      // Already at a stop when first seen, including one it stands just past, it's not known when it got there
      const line = lines[point.line]
      const ahead = stopAhead(line, point.distance)
      state = { line, last: point, ahead: ahead - 1, quarters: [] }
      const at = stopAt(state, point)
      state.ahead = at ? at.index + 1 : ahead
      if (at)
        state.at = { ...at, arrive: exactly(point.fix.at), isJoined: true }
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
      // At a stop it was first seen at, when it got there is unknown, so it's been through none yet
      ...at
        ? !at.isJoined && { last: { stop: stopId(line, at.index), index: at.index, distance: stopDistance(line, at.index), arrive: at.arrive.median } }
        : passed && { last: { stop: passed.stop, index: passed.index, distance: passed.distance, arrive: passed.arrive.median, depart: passed.depart.median } }
    }
  }

  return { push, end, location }
}
