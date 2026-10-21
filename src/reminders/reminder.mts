// A reminder as the phone keeps it, which is the whole of it: the bus, its stop, the walk, where it's going and by
// when, made from an itinerary (reminderOf). The phone works out how long before the bus to be woken (leadTime), asks
// the Worker to watch that run that far ahead (watchOf), and when the Worker pushes what it foretells of it, works
// out what that means for the trip (meaningOf) and words it (textOf). Every push says something, as iOS requires

import * as v from "valibot"
import { TIME_ZONE } from "../shared/time.mts"
import { type Feed, routeLabel } from "../transit/feed.mts"
import type { Itinerary } from "../routing/plan.mts"
import { type Watch, Wake } from "./watch.mts"

export const Reminder = v.object({
  id:        v.string(),
  /** The trip, its route, and the stop to board at, by the timetable's ids, and as the map shows them */
  trip:      v.string(),
  route:     v.string(),
  stop:      v.string(),
  routeName: v.string(),
  stopName:  v.string(),
  /** Epoch seconds the bus is scheduled to leave the stop, which names its run, and was expected to when the reminder was set */
  scheduled: v.number(),
  expected:  v.number(),
  /** s from leaving to the stop, and s before the bus to wake the phone */
  walk:      v.number(),
  lead:      v.number(),
  /** Where the trip goes and when it gets there, as planned */
  to:        v.string(),
  arrival:   v.number()
})
export type Reminder = v.InferOutput<typeof Reminder>

/** Where a reminder stands with the Worker: kept here before the Worker's taken it, taken, or cancelled here before the Worker's heard */
export const STATES = ["setting", "set", "cancelling"] as const
export type State = typeof STATES[number]

/** A reminder as kept on the phone: where it stands, and the last push shown for it, which a push older than it defers to */
export const Kept = v.object({ ...Reminder.entries, state: v.picklist(STATES), last: v.optional(Wake) })
export type Kept = v.InferOutput<typeof Kept>

/** s, the heads-up before you have to leave, as a reminder is by default */
export const HEADS_UP = 300
/** s, the least and most a reminder wakes the phone before the bus */
export const MIN_LEAD = 60
export const MAX_LEAD = 3600
/** s more while no bus is on the trip yet: the one that takes it can start it off its time by more than the band */
export const NOT_LIVE = 60

/**
 * Seconds before the bus could leave to wake the phone: a chosen lead as is, else the walk, a heads-up, and a minute
 * more while the bus isn't out yet. The slack the bus's time needs is the Worker's to allow, from the forecast's band
 * at the time. A whole half minute, so a replan seconds apart doesn't move it, between MIN_LEAD and MAX_LEAD
 */
export const leadTime = ({ walk, isLive, override }: { walk: number, isLive: boolean, override?: number }) => {
  const seconds = override ?? Math.max(0, walk) + HEADS_UP + (isLive ? 0 : NOT_LIVE)
  return Math.min(MAX_LEAD, Math.max(MIN_LEAD, Math.ceil(seconds / 30) * 30))
}

/**
 * The reminder an itinerary sets, by an id: its first bus and the walk to its stop, which is the first walk leg's own
 * length without the wait at the stop, and where it goes. Undefined for an itinerary with no bus
 */
export const reminderOf = (feed: Feed, itinerary: Itinerary, id: string, override?: number): Reminder | undefined => {
  const ride = itinerary.legs.find(leg => leg.kind === "ride")
  if (!ride)
    return undefined
  const { run, fromPosition, start } = ride
  const [first] = itinerary.legs
  const last = itinerary.legs.at(-1)!
  const walk = first.kind === "walk" ? first.end - first.start : 0
  const stop = feed.stops[run.trip.stops[fromPosition]]
  return {
    id,
    trip:      run.trip.id,
    route:     run.trip.route,
    stop:      stop.id,
    routeName: routeLabel(feed.routesById.get(run.trip.route)!),
    stopName:  stop.name,
    scheduled: run.base + run.trip.times[fromPosition],
    expected:  start,
    walk,
    lead:      leadTime({ walk, isLive: run.isLive, override }),
    to:        last.kind === "walk" ? last.to.name : feed.stops[last.run.trip.stops[last.toPosition]].name,
    arrival:   itinerary.end
  }
}

export const watchOf = ({ stop, route, trip, scheduled, lead }: Reminder): Watch =>
  ({ stop, route, trip, scheduled, lead })

/**
 * What a push means for the bus: leave for it, or it's moved since the last word, by when it's foretold and with how
 * early to be there; it's missing, as the run is cancelled or past, or was gone before it was ever near; or notunh
 * lost track of it, as the timetable changed under the watch
 */
export type Meaning = { kind: "leave" | "update", eta: number, band: number, isLive: boolean } | { kind: "missing" } | { kind: "lost" }

export const meaningOf = ({ kind, seen }: Wake): Meaning => {
  if (seen.status === "lost")
    return { kind: "lost" }
  if (kind === "over" || seen.status !== "coming")
    return { kind: "missing" }
  return { kind: kind === "update" ? "update" : "leave", eta: seen.time, band: seen.band, isLive: seen.isLive }
}

const clock = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" })
const clockOf = (seconds: number) =>
  clock.format(seconds * 1000)

const minutesOf = (seconds: number) =>
  Math.max(1, Math.round(seconds / 60))

/** When to leave for the bus: early enough to walk there with the slack its time needs, as the Worker's forecast has it */
export const leaveAt = ({ walk }: Reminder, eta: number, band: number) =>
  eta - walk - band

const leaveIn = (leave: number, now: number) =>
  leave - now < 60 ? "Leave now" : `Leave in ${minutesOf(leave - now)} min`

const drift = ({ expected }: Reminder, eta: number) => {
  const minutes = Math.round((eta - expected) / 60)
  if (minutes >= 1)
    return ` (${minutes} min late)`
  return minutes <= -1 ? ` (${-minutes} min early)` : ""
}

/** What a push's notification says, or without the reminder kept here, as when it's been forgotten, only to look */
export const textOf = (wake: Wake, reminder: Kept | undefined, now: number): { title: string, body: string } => {
  if (!reminder)
    return { title: "Time to head out", body: "Open notunh for your bus." }
  const bus = `Bus ${reminder.routeName}`
  if (reminder.state === "cancelling")
    return { title: "Reminder cancelled", body: `You cancelled the reminder for ${bus} at ${reminder.stopName}. Open notunh if you still want it.` }
  const meaning = meaningOf(wake)
  if (meaning.kind === "lost")
    return {
      title: "notunh lost track of this bus",
      body:  `The timetable changed since you set a reminder for the ${clockOf(reminder.expected)} ${bus} at ${reminder.stopName}. Open notunh for another way to ${reminder.to}.`
    }
  if (meaning.kind === "missing")
    return {
      title: `${bus} may not be coming`,
      body:  `notunh doesn't see the ${clockOf(reminder.expected)} at ${reminder.stopName}. Open notunh for another way to ${reminder.to}.`
    }
  const { kind, eta, band, isLive } = meaning
  const leave = leaveAt(reminder, eta, band)
  return {
    title: kind === "update" ? `${bus} is now due at ${clockOf(eta)}` : leaveIn(leave, now),
    body:  `${kind === "update" ? `${leaveIn(leave, now)}. ` : ""}` +
           `${bus} reaches ${reminder.stopName} at ${clockOf(eta)}${drift(reminder, eta)}${isLive ? "" : " (scheduled)"}, ` +
           `${minutesOf(reminder.walk)} min walk. You'll be at ${reminder.to} around ${clockOf(reminder.arrival + eta - reminder.expected)}.`
  }
}
