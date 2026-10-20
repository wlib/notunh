// When each room usually has a machine free, learned by the nightly build from the collector's transitions and read
// by the page. For every room, kind, and hour of the week it keeps time-weighted sums of the free count and of
// whether any was free. Days are folded in one at a time with src/shared/learn.mts' decay, so this semester's
// pattern takes over within a month

import * as v from "valibot"
import { foldDay, type Learned as Folded } from "../shared/learn.mts"
import { HOUR, localDay, localHour, weekday, addDays, dayStart, Day } from "../shared/time.mts"
import { KINDS, type Kind, type Known, type Poll, type Status, type Transition } from "./infer.mts"

/** Hours in a week, Monday midnight in Durham first */
export const SLOTS = 168
/**
 * The prior weight, in decayed hours watched, of a room's all-hours average behind each hour of the week. Each slot
 * leans on that average until it's been watched about this long. A slot gains at most an hour a week, so with the
 * 28-day half-life it levels off near 6, where its own hours and the average count equally. Held out on Oct 8 to 18
 * (at most two weeks of any hour), this tied the plain all-hours average. Both beat the hours alone by 0.007 to 0.02
 * in Brier score, and the hours alone, without the average beneath them, said nothing at all
 */
const POOLED_HOURS = 6
// A room doing less than this share of its usual business that day is on a break, and would teach us nothing
const QUIET_SHARE = 0.15
const TRAILING_DAYS = 28
// Days of business a room needs before any day of its own can count as quiet
const MIN_TRAILING_DAYS = 7

/** From 1 to 6 AM nobody's waiting on a washer, so the collector polls every 15 minutes rather than 5 */
export const pollMinutes = (ms: number) => {
  const hour = localHour(ms)
  return hour >= 1 && hour < 6 ? 15 : 5
}

/** The hour of the week in Durham at an epoch millisecond */
export const slotOf = (ms: number) =>
  weekday(localDay(ms)) * 24 + localHour(ms)

/** How many machines were free from one epoch millisecond to another */
export type Step = { from: number, to: number, free: number }

export type Span = { from: number, to: number }

/** Seconds-weighted sums by hour of the week */
export type Stats = { free: number[], any: number[], weight: number[] }

export const emptyStats = (): Stats =>
  ({ free: Array(SLOTS).fill(0), any: Array(SLOTS).fill(0), weight: Array(SLOTS).fill(0) })

/** The free count over a window, from each machine's status at its start and the transitions within it, in order */
export const occupancy = (initial: ReadonlyMap<string, Status>, transitions: readonly Transition[], from: number, to: number): Step[] => {
  const states = new Map(initial)
  const free = () => [...states.values()].filter(status => status === "free").length
  const steps: Step[] = []
  let at = from
  for (const transition of transitions) {
    if (transition.at < from || transition.at >= to)
      continue
    if (transition.at > at)
      steps.push({ from: at, to: transition.at, free: free() })
    states.set(transition.machine, transition.status)
    at = transition.at
  }
  if (to > at)
    steps.push({ from: at, to, free: free() })
  return steps
}

/**
 * The stretches of a window we actually watched a room: between two runs in a row that both fetched it, no further
 * apart than twice the usual interval, so an outage, ours or the vendor's, counts as unknown rather than quiet
 */
export const coverage = (polls: readonly Poll[], room: string, from: number, to: number): Span[] => {
  const spans: Span[] = []
  for (let i = 1; i < polls.length; i++) {
    const [a, b] = [polls[i - 1], polls[i]]
    if (a.failed.includes(room) || b.failed.includes(room) || b.at - a.at > 2 * pollMinutes(a.at) * 60_000)
      continue
    const span = { from: Math.max(a.at, from), to: Math.min(b.at, to) }
    if (span.from >= span.to)
      continue
    const last = spans.at(-1)
    if (last?.to === span.from)
      last.to = span.to
    else
      spans.push(span)
  }
  return spans
}

/** The sums with the watched part of each step added, split at the hours */
export const accumulate = (stats: Stats, steps: readonly Step[], covered: readonly Span[]): Stats => {
  const next: Stats = { free: [...stats.free], any: [...stats.any], weight: [...stats.weight] }
  for (const step of steps)
    for (const span of covered)
      for (let at = Math.max(step.from, span.from), end = Math.min(step.to, span.to); at < end;) {
        const until = Math.min(end, (Math.floor(at / HOUR) + 1) * HOUR)
        const slot = slotOf(at)
        const seconds = (until - at) / 1000
        next.weight[slot] += seconds
        next.free[slot] += step.free * seconds
        next.any[slot] += step.free > 0 ? seconds : 0
        at = until
      }
  return next
}

/** A room and kind's week as the page gets it: 168 bytes each, in base64 */
const Week = v.object({
  total: v.number(),
  /** Mean free count times 16, at most 255 */
  free:  v.string(),
  /** Share of the hour with any free, times 255 */
  any:   v.string(),
  /** Half-hours of watching behind each, decayed */
  known: v.string()
})
export type Week = v.InferOutput<typeof Week>

/** What the page loads */
export const Usual = v.object({
  through: v.nullable(Day),
  rooms:   v.record(v.string(), v.record(v.picklist(KINDS), Week))
})
export type Usual = v.InferOutput<typeof Usual>

export const emptyUsual = (): Usual =>
  ({ through: null, rooms: {} })

const byte = (x: number) =>
  Math.min(255, Math.max(0, Math.round(x)))

const toBase64 = (bytes: number[]) =>
  btoa(String.fromCharCode(...bytes))

const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text), char => char.charCodeAt(0))

export const quantize = (stats: Stats, total: number): Week => {
  const mean = (sums: number[], h: number) => stats.weight[h] ? sums[h] / stats.weight[h] : 0
  return {
    total,
    free:  toBase64(stats.free.map((_, h) => byte(mean(stats.free, h) * 16))),
    any:   toBase64(stats.any.map((_, h) => byte(mean(stats.any, h) * 255))),
    known: toBase64(stats.weight.map(seconds => byte(seconds / 1800)))
  }
}

/**
 * A room and kind's week as the page reads it: how many machines, and each hour's usual free count and chance of any
 * free, as watched then and leaning on the room's all-hours average, or nothing for a room never watched
 */
export const unpack = (week: Week) => {
  const [free, any, known] = [week.free, week.any, week.known].map(fromBase64)
  const hours = [...known].map(halves => halves / 2)
  const watched = hours.reduce((sum, h) => sum + h, 0)
  if (!watched)
    return
  const average = (values: Uint8Array, scale: number) =>
    values.reduce((sum, value, h) => sum + value / scale * hours[h], 0) / watched
  const [freeAll, anyAll] = [average(free, 16), average(any, 255)]
  return {
    total: week.total,
    hours: hours.map((h, slot) => {
      const own = h / (h + POOLED_HOURS)
      return { free: own * free[slot] / 16 + (1 - own) * freeAll, any: own * any[slot] / 255 + (1 - own) * anyAll }
    })
  }
}

export type UsualWeek = NonNullable<ReturnType<typeof unpack>>

/**
 * What the build keeps from night to night: each room and kind's sums, each machine's status as the last day
 * ended, and how much business each room did on its recent watched days
 */
export type Learned = Folded & {
  stats:    Record<string, Partial<Record<Kind, Stats>>>,
  statuses: Record<string, Status>,
  business: Record<string, number[]>
}

export const emptyLearned = (): Learned =>
  ({ version: 1, through: null, stats: {}, statuses: {}, business: {} })

const median = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
}

/** Every room's sums scaled, whether or not it was watched since */
const scale = (learned: Learned, by: number): Learned => ({
  ...learned,
  stats: Object.fromEntries(Object.entries(learned.stats).map(([room, kinds]) => [room, Object.fromEntries(
    Object.entries(kinds).map(([kind, stats]) => [kind, { free: stats.free.map(x => x * by), any: stats.any.map(x => x * by), weight: stats.weight.map(x => x * by) }])
  )]))
})

/**
 * A day folded into what's learned, from its transitions in order and the runs around it. A room on a break,
 * doing next to nothing next to its recent days, adds nothing
 */
export const update = (learned: Learned, machines: readonly Known[], day: Day, transitions: readonly Transition[], polls: readonly Poll[]) =>
  foldDay(learned, day, scale, before => {
    const [from, to] = [dayStart(day), dayStart(addDays(day, 1))]
    const kindOf = new Map(machines.map(({ machine, kind }) => [machine, kind]))
    const next: Learned = { ...before, stats: {}, statuses: { ...before.statuses }, business: { ...before.business } }
    for (const room of new Set(machines.map(({ room }) => room))) {
      const inRoom = transitions.filter(transition => transition.room === room && transition.at >= from && transition.at < to)
      const covered = coverage(polls, room, from, to)
      const starts = inRoom.filter(({ status }) => status === "running").length
      const trailing = before.business[room] ?? []
      const isQuiet = trailing.length >= MIN_TRAILING_DAYS && starts < QUIET_SHARE * median(trailing)
      if (covered.length)
        next.business[room] = [...trailing, starts].slice(-TRAILING_DAYS)

      next.stats[room] = {}
      for (const kind of KINDS) {
        const ofKind = machines.filter(m => m.room === room && m.kind === kind)
        if (!ofKind.length)
          continue
        const initial = new Map(ofKind.flatMap(({ machine }) => machine in before.statuses ? [[machine, before.statuses[machine]] as const] : []))
        const steps = isQuiet ? [] : occupancy(initial, inRoom.filter(({ machine }) => kindOf.get(machine) === kind), from, to)
        next.stats[room][kind] = accumulate(before.stats[room]?.[kind] ?? emptyStats(), steps, covered)
      }
    }
    for (const { machine, status } of transitions)
      next.statuses[machine] = status
    return next
  })

/** What the page loads: each room and kind's week, quantized, for kinds the room has machines of */
export const bundle = (learned: Learned, machines: readonly Known[] = []): Usual => ({
  through: learned.through,
  rooms: Object.fromEntries(Object.entries(learned.stats).map(([room, kinds]) => [room, Object.fromEntries(
    Object.entries(kinds).map(([kind, stats]) => [kind, quantize(stats, machines.filter(m => m.room === room && m.kind === kind).length)])
  )]))
})
