// How the Worker watches a bus for a phone: told which run, by its trip and its scheduled time at the stop, and how
// far ahead of the bus to wake the phone, it forecasts the run's departure from the stop with the model each check
// (forecast.mts), halving the wait as the time nears, and pushes once the bus could leave within the lead. It then
// follows the bus and pushes again only if its time moves by minutes or it's gone, or once, if the run was gone
// before it was ever near. Every push shows a notification, as iOS requires, so pushes are few. The phone makes of
// each what it means for its trip (reminder.mts)

import * as v from "valibot"

/** s, the soonest one check follows another while the wait is halved */
export const MIN_CHECK = 30
/** s between checks once the bus is near or the phone's been told */
export const FOLLOW = 60
/** s a bus's time has to move after the phone's told for it to be told again */
export const SHIFT = 120
export const MAX_PUSHES = 3
/** s past its time a bus is taken to have gone by */
export const GONE = 120
/** s past its scheduled time a run still followed is given up on */
export const LATEST = 2 * 3600
/** s ahead a run may be watched from: tomorrow's last bus, set tonight */
export const FURTHEST = 36 * 3600
/** Times a push the service couldn't take is tried, each wait twice the last from MIN_CHECK, unless it says when */
export const MAX_TRIES = 5
/** The shape of a push, which a service worker that doesn't know shows a plain notification for */
export const WAKE_VERSION = 1

/**
 * What the Worker is told: the run, as the trip's id and its scheduled departure from the stop in epoch seconds,
 * which names it among the day's runs and finds it again under a timetable that renames trips, the stop, both by the
 * timetable's ids, and s before the bus to wake the phone
 */
export const Watch = v.object({
  stop:      v.pipe(v.string(), v.maxLength(100)),
  route:     v.pipe(v.string(), v.maxLength(100)),
  trip:      v.pipe(v.string(), v.maxLength(100)),
  scheduled: v.pipe(v.number(), v.integer()),
  lead:      v.pipe(v.number(), v.minValue(60), v.maxValue(3600))
})
export type Watch = v.InferOutput<typeof Watch>

/**
 * What the forecast says of the run at a check: when its bus leaves the stop, in epoch seconds, how early to be there
 * for it (the band), whether a bus is on it rather than it being foretold from the timetable, and whether it's still
 * coming, cancelled by the source's word, lost to a timetable that no longer has it, or past the stop
 */
export const Seen = v.object({
  time:   v.number(),
  band:   v.number(),
  isLive: v.boolean(),
  status: v.picklist(["coming", "cancelled", "lost", "passed"])
})
export type Seen = v.InferOutput<typeof Seen>

/** Why a push came: the bus is within the lead, its time moved by minutes or it went missing since, or the run was gone before it was ever near */
export const KINDS = ["due", "update", "over"] as const
export type Kind = typeof KINDS[number]

/** What a push carries to the phone: its shape's version, the reminder, why, what the forecast says of its run, and when */
export const Wake = v.object({ v: v.literal(WAKE_VERSION), reminder: v.string(), kind: v.picklist(KINDS), seen: Seen, at: v.number() })
export type Wake = v.InferOutput<typeof Wake>

export type Watched = Watch & {
  pushes: number,
  /** The bus's time as the phone was last told it, once it's been told */
  told?:  number,
  /** Epoch seconds of the next check, or undefined once there's nothing more to do */
  next?:  number,
  /** A push made that the service hasn't taken yet: how many times it's been tried, and epoch seconds to try it next */
  owed?:  { wake: Wake, tries: number, at: number }
}

/** A watch as set, due for its first check at once */
export const watched = (watch: Watch, now: number): Watched =>
  ({ ...watch, pushes: 0, next: now })

/** A push's JSON, a couple of hundred bytes, well within the 4 KB push services take */
export const pushOf = (wake: Wake) =>
  JSON.stringify(wake)

/** The run isn't coming: the source says so, or the timetable no longer has it */
const isGone = (seen: Seen | undefined) =>
  seen?.status === "cancelled" || seen?.status === "lost"

/**
 * A watch whose push the service couldn't take just now: owed still, and tried again after the seconds the service
 * asked for, else after MIN_CHECK doubled each try; or, once tried MAX_TRIES times or the run is long past, the push
 * given up
 */
export const retried = (watched: Watched, now: number, asked?: number): Watched => {
  const tries = (watched.owed?.tries ?? 0) + 1
  if (tries > MAX_TRIES || now > watched.scheduled + LATEST || !watched.owed)
    return { ...watched, owed: undefined }
  return { ...watched, owed: { ...watched.owed, tries, at: now + (asked ?? MIN_CHECK * 2 ** (tries - 1)) } }
}

/** The next check: halving the wait until the bus could be within the lead, then a minute at a time */
const plan = (watched: Watched, now: number, earliest: number): Watched => {
  const wait = earliest - watched.lead - now
  if (wait <= 0)
    return { ...watched, next: now + FOLLOW }
  return { ...watched, next: now + (wait < 2 * MIN_CHECK ? Math.max(wait, MIN_CHECK / 2) : wait / 2) }
}

const ended = (watched: Watched): Watched =>
  ({ ...watched, next: undefined })

/**
 * A check at `now`, with what the forecast says of the run, or undefined if it couldn't be made: the watch as it goes
 * on, and what to push. Before the phone's told, it's woken once the bus could leave, its band allowed, within the
 * lead; a run gone or past before then is said so once. Told, it hears again only of a move by SHIFT or of the run
 * going missing, at most MAX_PUSHES times in all, and the watch ends once the bus has gone by
 */
export const check = (before: Watched, seen: Seen | undefined, now: number): { watched: Watched, push?: Kind } => {
  const { told } = before
  if (told === undefined) {
    if (seen?.status === "passed" || isGone(seen) || now > before.scheduled + LATEST)
      return { watched: { ...ended(before), pushes: 1 }, push: "over" }
    if (!seen)
      return { watched: plan(before, now, before.scheduled) }
    if (seen.time - seen.band - now <= before.lead)
      return { watched: { ...before, pushes: 1, told: seen.time, next: now + FOLLOW }, push: "due" }
    return { watched: plan(before, now, seen.time - seen.band) }
  }
  if (seen?.status === "passed" || now > Math.max(told, before.scheduled) + LATEST)
    return { watched: ended(before) }
  if (seen && before.pushes < MAX_PUSHES && (isGone(seen) || Math.abs(seen.time - told) >= SHIFT)) {
    const pushed = { ...before, pushes: before.pushes + 1 }
    return { watched: isGone(seen) ? ended(pushed) : { ...pushed, told: seen.time, next: now + FOLLOW }, push: "update" }
  }
  if (isGone(seen) || (seen === undefined && now > told + GONE))
    return { watched: ended(before) }
  return { watched: { ...before, next: now + FOLLOW } }
}
