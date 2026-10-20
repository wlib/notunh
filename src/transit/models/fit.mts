// The model fitted in the nightly build a service day at a time. A day's visits make statistics, sums over the day
// (summarize), and the model is those folded together, each decayed by half every HALF_LIFE days, so a new semester
// takes over within a month. Changing the half-life only takes folding the same statistics again. Beside them, each
// day's evaluation of how the model forecast it is folded into its scores the same way, but only alongside others of
// the same predictor: another's start the scores afresh, so the bands are calibrated by one predictor alone.
//
// Weighing visits by how sure their times are measured no better than weighing them all the same. A visit last seen
// still at its stop, or first seen already there, teaches only the leg driven to or from it, as its stay was cut
// short. Counting when one first seen there left changed nothing held out

import { type Cell, type Evaluation, type Model, type Statistics, type Tally, ANY_LAYOVER, ANY_LEG, ANY_STOP, CONTEXTS, LINGERED, contextAt, dayTypeAt, emptyModel, emptyScores, hourAt, zoneKey } from "./model.mts"
import { type Visit, INCOMPLETE, JOINED } from "../inference/events.mts"
import { alwaysListening } from "../observations/raw.mts"
import { foldDay } from "../../shared/learn.mts"
import { groupBy } from "../../shared/group.mts"
import type { Day } from "../../shared/time.mts"

// Bounds on what's learned from, each set where the data has a gap between two kinds of thing rather than a spread
// of one.
// - MAX_GAP: a bus not seen driving between two stops it visited (off its route, or lost to its GPS) that took longer
//   was doing something other than driving the leg. Such gaps take about two minutes or the better part of an hour,
//   with few between
// - MAX_ZONE, MAX_LINGER: longer at a stop is out of service, and longer still not a visit at all. One stay in 10,000
//   is over 7 minutes
// - MAX_OFFSET: further off its timetable, a bus is on another trip than the one it's tagged with, like a connector
//   running a lap late on its last lap's tag
const MAX_GAP = 600      // s
const MAX_ZONE = 900     // s
const MAX_LINGER = 1800  // s
const MAX_OFFSET = 900   // s
// Cells decayed below this are dropped, keeping the model to what's still running
const MIN_N = 0.01

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


// Longer between buses at a stop is a gap in service, not a headway
const MAX_HEADWAY = 3 * 3600 // s

// A visit this much ahead of its timetable could have waited for it, and one leaving this close to its scheduled
// time did. Waiting is too rare to fit as a likelihood, against leaving as soon as done, as the waits would mix
// away into nothing: 43 of 11,449 visits a minute or more early on Oct 7 to 19
const EARLY = 60 // s
const GRACE = 30 // s

/**
 * What a service day's visits show. A headway is only counted where the Worker was listening throughout, as it may
 * have missed a bus between otherwise
 */
export const summarize = (visits: readonly Visit[], isListening = alwaysListening): Statistics => {
  const { version: _, through: __, scores: ___, ...next } = emptyModel()
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
      // Every leg between stops visited one after the other, as the time from leaving one to getting to the other.
      // Where the bus was lost between them, only as long as that could have been driving
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

      if (flags & (INCOMPLETE | JOINED))
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
  const byStop = groupBy(visits.filter(({ flags = 0 }) => !(flags & (INCOMPLETE | JOINED))), ({ route, stop }) => `${route}@${stop}`)
  for (const own of byStop.values()) {
    own.sort((a, b) => a.depart - b.depart)
    own.forEach(({ route, vehicle, depart }, i) => {
      const previous = own[i - 1]
      if (previous && previous.vehicle !== vehicle && depart - previous.depart < MAX_HEADWAY && isListening(previous.depart * 1000, depart * 1000))
        addTo(next.headways, route, 2 * 24, hourAt(depart), depart - previous.depart)
    })
  }

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

/**
 * The model with a day folded in: its statistics, and its evaluation, if it was evaluated, with the scores of
 * another predictor dropped first
 */
export const fold = (model: Model, day: Day, statistics: Statistics, evaluation?: Evaluation) =>
  foldDay(model, day, scale, ({ version, through, predictor, scores, ...sums }) => ({
    version, through, ...merged(sums, statistics),
    ...evaluation
      ? { predictor: evaluation.predictor, scores: merged(predictor === evaluation.predictor ? scores : emptyScores(), evaluation.scores) }
      : { predictor, scores }
  }))

/** The model with a service day's visits folded in, and its evaluation if there is one */
export const update = (model: Model, day: Day, visits: readonly Visit[], evaluation?: Evaluation) =>
  fold(model, day, summarize(visits), evaluation)

