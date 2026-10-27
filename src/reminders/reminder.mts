// A reminder as the phone keeps it, which is the whole of it: the trip as planned, leg by leg, where it's from and
// to, by when it should get there if that was asked, and the heads-up wanted before leaving, made from an itinerary
// (reminderOf). The phone works out when to leave, which is the itinerary's own start, and how long before the first
// bus to be woken (leadTime), asks the Worker to watch that bus that far ahead, or to wake it at the leave time
// where there's no bus (watchOf), and when the Worker pushes what it foretells, works out what that means for the
// trip (meaningOf) and words it (textOf). Every push says something, as iOS requires. A reminder may be for a visit
// (src/shared/visit.mts), as from an event's or a class's page, and a class's carries a queue of the visits after it
// (queue.mts), which the phone moves on to as each is told of

import * as v from "valibot"
import { clockOf } from "../shared/time.mts"
import { type Feed, routeLabel } from "../transit/feed.mts"
import { type Itinerary, cost, wayKey } from "../routing/plan.mts"
import { walkAllowance } from "../routing/walks.mts"
import { slack } from "../transit/models/forecast.mts"
import { type Watch, Wake } from "./watch.mts"
import { Visit, thereBy } from "../shared/visit.mts"

/** A place as planned from or to, and whether it was where you were, which a replan takes from where you are then */
export const Place = v.object({ lat: v.number(), lon: v.number(), name: v.string(), isYou: v.optional(v.literal(true)) })

/** A leg as kept: a walk, with s allowed for it and where it ends, or a ride, with the bus's run and stop by the timetable's ids and as the map shows them */
export const Leg = v.variant("kind", [
  v.object({ kind: v.literal("walk"), walk: v.number(), to: v.string() }),
  v.object({
    kind:      v.literal("ride"),
    trip:      v.string(),
    route:     v.string(),
    stop:      v.string(),
    routeName: v.string(),
    stopName:  v.string(),
    /** Epoch seconds the bus is scheduled to leave the stop, which names its run, and was expected to when the reminder was set */
    scheduled: v.number(),
    expected:  v.number(),
    /** Whether a bus was on the run when the reminder was set */
    isLive:    v.boolean()
  })
])
export type Leg = v.InferOutput<typeof Leg>

export const Reminder = v.object({
  id:      v.string(),
  /** Where the trip goes, as planned, so a notification can open it again and plan it afresh from where you are */
  from:    Place,
  to:      Place,
  /** Which way it goes (wayKey), so a replan's fresher copy of the same trip is still this reminder's */
  way:     v.string(),
  legs:    v.array(Leg),
  /** Epoch seconds to leave, and when the trip gets there, as planned */
  start:   v.number(),
  end:     v.number(),
  /** Epoch seconds it was asked to get there by, if it was */
  by:      v.optional(v.number()),
  /** s before leaving to wake the phone */
  headsUp: v.number(),
  /**
   * s the first bus may run late before the rest of the trip no longer holds: the least of each change's slack, less
   * the next bus's own, and of what's left before `by`, or none with neither a change nor a `by`
   */
  margin:  v.optional(v.number()),
  /** The visit it's for, if it's for one rather than a trip planned on the map, whose way is then whichever's best when it's planned again */
  visit:   v.optional(Visit)
})
export type Reminder = v.InferOutput<typeof Reminder>

/** Where a reminder stands with the Worker: kept here before the Worker's taken it, taken, or cancelled here before the Worker's heard */
export const STATES = ["setting", "set", "cancelling"] as const
export type State = typeof STATES[number]

/** A visit still to come in a class reminder's queue, with where it is as the map had it, which the service worker can't look up */
export const Target = v.object({ visit: Visit, to: Place })
export type Target = v.InferOutput<typeof Target>

/**
 * The visits a class reminder goes on to after the one it's for (queue.mts): the section they're of, by the id the
 * courses give it, kept on the phone alone; the next ones, soonest first; whether those reach the section's last
 * meeting, or more were left for a later top-up; s door to door as last planned, which a visit not yet planned is
 * left that long before; and epoch seconds the current visit was moved on to, before which a push is of one before
 */
export const Queue = v.object({ section: v.string(), next: v.array(Target), complete: v.boolean(), travel: v.number(), since: v.number() })
export type Queue = v.InferOutput<typeof Queue>

/** A reminder as kept on the phone: where it stands, the last push shown for it, which a push older than it defers to, and for a class, its queue */
export const Kept = v.object({ ...Reminder.entries, state: v.picklist(STATES), last: v.optional(Wake), queue: v.optional(Queue) })
export type Kept = v.InferOutput<typeof Kept>

/** s, the heads-up before you have to leave, as a reminder is by default, and the ones to choose from */
export const HEADS_UP = 300
export const HEADS_UPS = [120, 300, 600, 900]
/** s, the least and most a watch wakes the phone before its time */
export const MIN_LEAD = 60
export const MAX_LEAD = 3600
/** s more while no bus is on the trip yet: the one that takes it can start it off its time by more than the band */
export const NOT_LIVE = 60
/** s of heads-up and more within which there's nothing to remind: the card's own "leave in" is the reminder */
export const TOO_SOON = 60

/** The first ride of a reminder, which is the one the Worker watches, if there is one */
export const firstRide = ({ legs }: Pick<Reminder, "legs">) =>
  legs.find(leg => leg.kind === "ride")

/** s from leaving to the first bus's stop, allowance and all, which is the walk the Worker's lead and the notification's leave time are counted back by */
export const walkOf = ({ legs }: Pick<Reminder, "legs">) => {
  const [first] = legs
  return first?.kind === "walk" ? first.walk : 0
}

/**
 * Seconds before its time to wake the phone: for a watch on a bus, the walk to its stop, the heads-up, and a minute
 * more while the bus isn't out yet, as the slack the bus's time needs is the Worker's to allow from the forecast's
 * band at the time; for a fixed time, the heads-up alone. A whole half minute, so a replan seconds apart doesn't
 * move it, between MIN_LEAD and MAX_LEAD
 */
export const leadTime = ({ walk, isLive, headsUp }: { walk: number, isLive: boolean, headsUp: number }) => {
  const seconds = Math.max(0, walk) + headsUp + (isLive ? 0 : NOT_LIVE)
  return Math.min(MAX_LEAD, Math.max(MIN_LEAD, Math.ceil(seconds / 30) * 30))
}

/** Whether a trip is too soon to be reminded of: its leave time is within the heads-up and a minute of now */
export const isTooSoon = ({ start, headsUp }: Pick<Reminder, "start" | "headsUp">, now: number) =>
  start - now <= headsUp + TOO_SOON

/** Whether a kept reminder is still one to show: not being cancelled, and of a trip not yet over */
export const isCurrent = ({ state, end }: Pick<Kept, "state" | "end">, now: number) =>
  state !== "cancelling" && end > now

/** The best of some ways there, as `options` ranks them, which a visit's reminder takes as nobody picked one */
export const bestOf = (options: Itinerary[], now: number, by: number | undefined) =>
  options.toSorted((a, b) => cost(a, now, by) - cost(b, now, by))[0] as Itinerary | undefined

/**
 * A kept trip planned again as of `now`, from the ways there now: its own way if that's still offered, else the
 * best, or for a visit, whichever's best now. None where that doesn't get there by its time, as the ways fall back
 * to leaving now when nothing makes it, or is too soon to be reminded of, as the card would never offer
 */
export const replanned = (feed: Feed, reminder: Kept, options: Itinerary[], now: number): Reminder | undefined => {
  const same = reminder.visit ? bestOf(options, now, reminder.by) : options.find(option => wayKey(option) === reminder.way) ?? options[0]
  if (!same || (reminder.by !== undefined && same.end > reminder.by))
    return
  const fresh = reminderOf(feed, same, reminder.id, now, { headsUp: reminder.headsUp, by: reminder.by, visit: reminder.visit })
  return isTooSoon(fresh, now) ? undefined : fresh
}

/**
 * The reminder for a visit not planned yet, as one the service worker moves on to or one set before where you are
 * is known: no legs, left `travel` s before the time to be there by, which is the last plan's length, until the map
 * plans it from where you are
 */
export const unplanned = (id: string, from: Reminder["from"], { visit, to }: Target, travel: number, headsUp = HEADS_UP): Reminder => {
  const by = Math.round(thereBy(visit) / 1000)
  return { id, from, to, way: "", legs: [], start: by - Math.round(travel), end: by, by, headsUp, visit }
}

/**
 * The reminder an itinerary sets, by an id, as of `now`, whatever its shape: walked the whole way, a walk and a bus,
 * or buses with changes between. Each walk is kept with its allowance (walks.mts), so the leave time is the
 * itinerary's own start. The margin is the least of each change's slack, counted from the bus before's arrival to
 * when the planner counts on catching the next, which is its departure less the slack its time needs, and of
 * what's left before `by`
 */
export const reminderOf = (feed: Feed, itinerary: Itinerary, id: string, now: number, { headsUp = HEADS_UP, by, visit }: { headsUp?: number, by?: number, visit?: Visit } = {}): Reminder => {
  const placeOf = ({ lat, lon, name, isYou }: v.InferOutput<typeof Place> & { isYou?: boolean }): v.InferOutput<typeof Place> => ({ lat, lon, name, ...isYou && { isYou: true as const } })
  const legs = itinerary.legs.map((leg): Leg => {
    if (leg.kind === "walk")
      return { kind: "walk", walk: walkAllowance(leg.meters, leg.via), to: leg.to.name }
    const { run, fromPosition, start } = leg
    const stop = feed.stops[run.trip.stops[fromPosition]]
    return {
      kind:      "ride",
      trip:      run.trip.id,
      route:     run.trip.route,
      stop:      stop.id,
      routeName: routeLabel(feed.routesById.get(run.trip.route)!),
      stopName:  stop.name,
      scheduled: run.base + run.trip.times[fromPosition],
      expected:  start,
      isLive:    run.isLive
    }
  })
  // Each change's slack: from the bus before's arrival to the next bus, less any walk between, allowance and all,
  // and less the slack the next bus's own time needs, which the planner's change counts on too
  const slacks = itinerary.legs.flatMap((leg, i) => {
    if (leg.kind !== "ride" || i === 0)
      return []
    const before = itinerary.legs[i - 1]
    const previous = before.kind === "ride" ? before : itinerary.legs[i - 2]
    if (previous?.kind !== "ride")
      return []
    return [leg.start - slack(leg.run, leg.fromPosition, leg.start, now) - previous.end - (before.kind === "walk" ? walkAllowance(before.meters, before.via) : 0)]
  })
  if (by !== undefined)
    slacks.push(by - itinerary.end)
  const [first] = itinerary.legs
  const last = itinerary.legs.at(-1)!
  return {
    id,
    from:    first.kind === "walk" ? placeOf(first.from) : placeOf(feed.stops[first.run.trip.stops[first.fromPosition]]),
    to:      last.kind === "walk" ? placeOf(last.to) : placeOf(feed.stops[last.run.trip.stops[last.toPosition]]),
    way:     wayKey(itinerary),
    legs,
    start:   itinerary.start,
    end:     itinerary.end,
    ...by !== undefined && { by },
    headsUp,
    ...slacks.length && { margin: Math.min(...slacks) },
    ...visit && { visit }
  }
}

/** What the Worker is asked to watch: the first bus, the lead before its scheduled time, or without one, the leave time and the heads-up */
export const watchOf = (reminder: Reminder): Watch => {
  const ride = firstRide(reminder)
  return ride
    ? { at: ride.scheduled, lead: leadTime({ walk: walkOf(reminder), isLive: ride.isLive, headsUp: reminder.headsUp }), run: { stop: ride.stop, route: ride.route, trip: ride.trip } }
    : { at: reminder.start, lead: leadTime({ walk: 0, isLive: true, headsUp: reminder.headsUp }) }
}

/**
 * What a push means for the trip: leave for it, or it's moved since the last word, by when its first bus is foretold
 * and with how early to be there; it's missing, as the run is cancelled or past, or was gone before it was ever
 * near; or notunh lost track of it, as the timetable changed under the watch
 */
export type Meaning = { kind: "leave" | "update", eta: number, band: number, isLive: boolean } | { kind: "missing" } | { kind: "lost" }

export const meaningOf = ({ kind, seen }: Wake): Meaning => {
  if (seen.status === "lost")
    return { kind: "lost" }
  if (kind === "over" || seen.status !== "coming")
    return { kind: "missing" }
  return { kind: kind === "update" ? "update" : "leave", eta: seen.time, band: seen.band, isLive: seen.isLive }
}

const minutesOf = (seconds: number) =>
  Math.max(1, Math.round(seconds / 60))

/** When to leave: early enough to walk to the first bus with the slack its time needs, as the Worker's forecast has it, or at the leave time itself */
export const leaveAt = (reminder: Pick<Reminder, "legs" | "start">, eta: number, band: number) =>
  firstRide(reminder) ? eta - band - walkOf(reminder) : eta

/** How late the first bus runs against the plan, in s, and whether the rest of the trip still holds */
export const delayOf = (reminder: Reminder, eta: number) => {
  const ride = firstRide(reminder)
  const delay = ride ? eta - ride.expected : 0
  return { delay, holds: reminder.margin === undefined || delay <= reminder.margin }
}

const leaveIn = (leave: number, now: number) =>
  leave - now < 60 ? "Leave now" : `Leave in ${minutesOf(leave - now)} min`

const drift = (delay: number) => {
  const minutes = Math.round(delay / 60)
  if (minutes >= 1)
    return ` (${minutes} min late)`
  return minutes <= -1 ? ` (${-minutes} min early)` : ""
}

/** What the last push a class reminder's queue holds says besides, when more were left for the phone to find */
export const LAST_KNOWN = "That was the last one I knew; open notunh to keep going."

/** Whether a kept reminder is the last its queue knows of, with more meetings still to come that the phone hasn't seen */
const isLastKnown = ({ queue }: Pick<Kept, "queue">) =>
  queue !== undefined && !queue.next.length && !queue.complete

/**
 * What a push's notification says, or without the reminder kept here, as when it's been forgotten, only to look.
 * Terse: when to leave, the first bus and how it's running, the walk, and where the trip ends up and when, only
 * while the rest of it still holds, else to open notunh. Where it goes is said here alone, never by the Worker. The
 * last of a class's queue says so, while more meetings may follow
 */
export const textOf = (wake: Wake, reminder: Kept | undefined, now: number): { title: string, body: string } => {
  const text = wordsOf(wake, reminder, now)
  return reminder && isLastKnown(reminder) ? { ...text, body: `${text.body} ${LAST_KNOWN}` } : text
}

const wordsOf = (wake: Wake, reminder: Kept | undefined, now: number): { title: string, body: string } => {
  if (!reminder)
    return { title: "Time to head out", body: "Open notunh for your trip." }
  const { to: { name: to }, by } = reminder
  const ride = firstRide(reminder)
  const bus = ride && `Bus ${ride.routeName}`
  const another = `Open notunh for another way to ${to}.`
  if (reminder.state === "cancelling")
    return { title: "Reminder cancelled", body: `You cancelled the reminder for ${to}. Open notunh if you still want it.` }
  const meaning = meaningOf(wake)
  if (meaning.kind === "lost")
    return { title: "notunh lost track of this trip", body: `The timetable changed since you set a reminder for ${to}. ${another}` }
  if (meaning.kind === "missing")
    return ride
      ? { title: `${bus} may not be coming`, body: `notunh doesn't see the ${clockOf(ride.expected * 1000)} at ${ride.stopName}. ${another}` }
      : { title: "Time to leave has passed", body: `Your ${clockOf(reminder.start * 1000)} ${reminder.legs.length ? "walk" : "trip"} to ${to} is past. ${another}` }
  const { kind, eta, band, isLive } = meaning
  const leave = leaveAt(reminder, eta, band)
  const { delay, holds } = delayOf(reminder, eta)
  // A visit not planned yet goes by the last plan's length, so its way is the map's to say
  if (!reminder.legs.length)
    return { title: leaveIn(leave, now), body: `${reminder.end > reminder.start ? `About ${minutesOf(reminder.end - reminder.start)} min to ${to}, there` : `Be at ${to}`} by ${clockOf(reminder.end * 1000)}.` }
  const walk = `${minutesOf(walkOf(reminder))} min walk`
  if (!ride)
    return { title: leaveIn(leave, now), body: `${walk} to ${to}, there ${clockOf(reminder.end * 1000)}${by === undefined ? "" : `, before your ${clockOf(by * 1000)}`}.` }
  const change = reminder.legs.filter(leg => leg.kind === "ride")[1]
  const then =
    holds            ? `${to} ${clockOf((reminder.end + delay) * 1000)}${by === undefined ? "" : `, before your ${clockOf(by * 1000)}`}` :
    change           ? `may miss the ${clockOf(change.expected * 1000)} change · ${another}` :
    by !== undefined ? `may be late for ${clockOf(by * 1000)} · ${another}` :
                       another
  return {
    title: kind === "update" ? `${bus} now ${clockOf(eta * 1000)}` : leaveIn(leave, now),
    body:  `${kind === "update" ? `${leaveIn(leave, now)} · ` : ""}${bus} at ${ride.stopName} ${clockOf(eta * 1000)}${drift(delay)}${isLive ? "" : " (scheduled)"} · ${walk} · ${then}`
  }
}
