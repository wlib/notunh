// A reminder as the phone keeps it, which is the whole of it: the bus, its stop, the walk, where it's going and by
// when. The phone works out how long before the bus to be woken (leadTime), asks the Worker to watch that run that
// far ahead (watchOf), and when the Worker pushes what it foretells of it, works out what that means for the trip
// (meaningOf) and words it (textOf). Every push says something, as iOS requires

import * as v from "valibot"
import { TIME_ZONE } from "../shared/time.mts"
import { type Wake, type Watch } from "./watch.mts"

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

export const watchOf = ({ stop, route, trip, scheduled, lead }: Reminder): Watch =>
  ({ stop, route, trip, scheduled, lead })

/**
 * What a push means for the bus: leave for it, or it's moved since the last word, by when it's foretold and with how
 * early to be there; or it's missing, as the run is cancelled or past, or was gone before it was ever near
 */
export type Meaning = { kind: "leave" | "update", eta: number, band: number, isLive: boolean } | { kind: "missing" }

export const meaningOf = ({ kind, seen }: Wake): Meaning =>
  kind === "over" || seen.status !== "coming"
    ? { kind: "missing" }
    : { kind: kind === "update" ? "update" : "leave", eta: seen.time, band: seen.band, isLive: seen.isLive }

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
  return minutes >= 1 ? ` (${minutes} min late)` : minutes <= -1 ? ` (${-minutes} min early)` : ""
}

/** What a push's notification says, or without the reminder kept here, as when it's been forgotten, only to look */
export const textOf = (wake: Wake, reminder: Reminder | undefined, now: number): { title: string, body: string } => {
  if (!reminder)
    return { title: "Time to head out", body: "Open notunh for your bus." }
  const bus = `Bus ${reminder.routeName}`
  const meaning = meaningOf(wake)
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
