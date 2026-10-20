// What weeks of the Worker's samples show of how the buses run: the statistics the nightly build keeps (fit.mts) and
// forecasting reads (estimates.mts). They cover
// - how long each leg between consecutive stops takes at each time of day, and how its time is spent along the way
// - how long buses spend at each stop and lay over at the start of a trip, and how much longer one already there stays
// - whether buses wait at a stop for its scheduled time
// - how far off the timetable each route runs, and how often its buses come
// - how forecasts from it have done, as the evaluations of one predictor scored them, which calibrates their bands
// Keys are stop and route ids, which last across timetables, never trip ids, which don't. A stop or route that keeps
// its id through a change of path or timetable keeps what was learned of it, which decays away as the new pattern
// is learned

import * as v from "valibot"
import { objectOf } from "../../shared/json.mts"
import { Day, localDay, localHour, weekday } from "../../shared/time.mts"

// Seconds already at a stop that how much longer it stays is learned from
export const LINGERED = [0, 5, 10, 20, 40, 80, 160, 320]

/** Minutes ahead that forecasts are scored at, each scoring those nearest it */
export const LEADS = [1, 3, 5, 10, 20, 30, 60]

/** A decayed count, sum, and sum of squares of observations */
export type Cell = [n: number, sum: number, sum2: number]

/** How a way of forecasting did at a lead: a decayed count and the sum of how far off it was, in s */
export type Tally = [n: number, error: number]

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
  /** The predictor whose evaluations the scores are of, which a model from before predictors were named leaves out */
  predictor: v.optional(v.string()),
  scores:   objectOf<Scores>()
})
export type Model = v.InferOutput<typeof Model>

/** What a service day's visits show, as sums over the day (fit.mts summarize), undecayed, which fold in as they are */
export type Statistics = Omit<Model, "version" | "through" | "predictor" | "scores">

/**
 * How a predictor did on a day: forecasting and replay as they were (scripts/map/replay.mts PREDICTOR), with the
 * model as it stood before the day
 */
export type Evaluation = { predictor: string, scores: Scores }
/** s something takes on average, and its variance */
export type Estimate = { mean: number, variance: number }

/** Bins of how many standard deviations off a forecast was, a quarter of a doubling each, from 1/64 to 64 */
export const RATIOS = 48
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
export const CONTEXTS = 2 * 24 / HOURS

/** The day type of an epoch second, in its service day in Durham, which runs on past midnight into the night */
export const dayTypeAt = (at: number) =>
  dayType(localDay((at - NIGHT_ENDS * 3600) * 1000))

/** An epoch second's day type and hour of the clock in Durham, as one index */
export const hourAt = (at: number) =>
  dayTypeAt(at) * 24 + localHour(at * 1000)

/** The context of an epoch second: its day type, and its two hours of the clock in Durham */
export const contextAt = (at: number) =>
  dayTypeAt(at) * 24 / HOURS + Math.floor(localHour(at * 1000) / HOURS)

//#endregion

//#region Keys

/** The key a stop's times are kept by: the stop on its route, or where a trip starts, the route's layover */
export const zoneKey = (route: string, stop: string, isFirst: boolean) =>
  isFirst ? `${route}^` : `${route}@${stop}`
// Every stop's, and every layover's, for routes the model knows nothing of yet, and every leg's profile
export const ANY_STOP = "@"
export const ANY_LAYOVER = "^"
export const ANY_LEG = "*"

//#endregion
