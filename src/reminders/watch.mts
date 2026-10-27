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
/** s ahead a watch on no run may be set from, which costs the Worker one alarm: a class's next meeting after a week's break, as its queue goes on (queue.mts) */
export const FURTHEST_FIXED = 15 * 86_400
/** Times a push the service couldn't take is tried, each wait twice the last from MIN_CHECK, unless it says when */
export const MAX_TRIES = 5
/** The shape of a push, which a service worker that doesn't know shows a plain notification for */
export const WAKE_VERSION = 1

/** The run a watch is on: its trip's id, the stop, and the route, all by the timetable's ids */
export const Run = v.object({
  stop:  v.pipe(v.string(), v.maxLength(100)),
  route: v.pipe(v.string(), v.maxLength(100)),
  trip:  v.pipe(v.string(), v.maxLength(100))
})
export type Run = v.InferOutput<typeof Run>

/**
 * What the Worker is told: when to wake the phone, as epoch seconds `at` and s before it, `lead`, and, where a bus
 * makes that time uncertain, the run it's on. With a run, `at` is the bus's scheduled departure from the stop, which
 * names the run among the day's and finds it again under a timetable that renames trips, and the Worker forecasts
 * it and wakes the phone the lead before the bus could leave, its band allowed. Without one, as for a trip walked
 * the whole way, `at` is the time to leave, and the phone is woken the lead before it, once
 */
export const Watch = v.object({
  at:   v.pipe(v.number(), v.integer()),
  lead: v.pipe(v.number(), v.minValue(60), v.maxValue(3600)),
  run:  v.optional(Run)
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
  /** What the phone was last told, once it has been: the bus's time, and when to be at the stop by, its band allowed */
  told?:  { time: number, by: number },
  /** Epoch seconds of the next check, or undefined once there's nothing more to do */
  next?:  number,
  /** A push made that the service hasn't taken yet: how many times it's been tried, and epoch seconds to try it next */
  owed?:  { wake: Wake, tries: number, at: number }
}

/** A watch as set, due for its first check at once */
export const watched = (watch: Watch, now: number): Watched =>
  ({ ...watch, pushes: 0, next: now })

/** Whether two watches are on the same thing: the same run, or the same fixed time with none */
const isSameRun = (a: Watch, b: Watch) =>
  a.at === b.at && a.run?.trip === b.run?.trip && a.run?.stop === b.run?.stop && a.run?.route === b.run?.route

/**
 * A watch set in place of what the device had under its id, due for a check at once: on the same run, it goes on as
 * the phone was told, its pushes counted, so a lead that moved as the trip was planned again doesn't wake the phone
 * again for the same bus; on another, it starts afresh
 */
export const replaced = (was: Watched | undefined, watch: Watch, now: number): Watched =>
  was && isSameRun(was, watch) ? { ...watched(watch, now), pushes: was.pushes, ...was.told && { told: was.told } } : watched(watch, now)

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
  if (tries > MAX_TRIES || now > watched.at + LATEST || !watched.owed)
    return { ...watched, owed: undefined }
  return { ...watched, owed: { ...watched.owed, tries, at: now + (asked ?? MIN_CHECK * 2 ** (tries - 1)) } }
}

/**
 * The next check: halving the wait until the bus could be within the lead, then a minute at a time. A watch on no
 * run has nothing to check on, so its next is the wake itself
 */
const plan = (watched: Watched, now: number, earliest: number): Watched => {
  const wait = earliest - watched.lead - now
  if (wait <= 0)
    return { ...watched, next: now + FOLLOW }
  if (!watched.run)
    return { ...watched, next: now + wait }
  return { ...watched, next: now + (wait < 2 * MIN_CHECK ? Math.max(wait, MIN_CHECK / 2) : wait / 2) }
}

const ended = (watched: Watched): Watched =>
  ({ ...watched, next: undefined })

/**
 * A check at `now`, with what the forecast says of the run, or undefined if it couldn't be made: the watch as it goes
 * on, and what to push. Before the phone's told, it's woken once the bus could leave, its band allowed, within the
 * lead; a run gone, or past once its scheduled time has gone too, is said so once. A forecast that has the bus past
 * the stop before its time is no news, as a followed bus can be placed ahead of itself, so the watch checks on. Told,
 * it hears again only of the run going missing, of having to be at the stop SHIFT earlier, band allowed, or of the
 * bus itself being SHIFT later, at most MAX_PUSHES times in all, and the watch ends once the bus has gone by. A band
 * that narrows as the bus nears is no news. A watch on no run is told once and ends, as a fixed time doesn't move
 */
export const check = (before: Watched, seen: Seen | undefined, now: number): { watched: Watched, push?: Kind } => {
  const { told } = before
  if (told === undefined) {
    if ((seen?.status === "passed" && now > before.at + GONE) || isGone(seen) || now > before.at + LATEST)
      return { watched: { ...ended(before), pushes: 1 }, push: "over" }
    if (!seen || seen.status === "passed")
      return { watched: plan(before, now, before.at) }
    const by = seen.time - seen.band
    if (by - now <= before.lead)
      return { watched: { ...before, pushes: 1, told: { time: seen.time, by }, next: before.run ? now + FOLLOW : undefined }, push: "due" }
    return { watched: plan(before, now, by) }
  }
  if (seen?.status === "passed" || now > Math.max(told.time, before.at) + LATEST)
    return { watched: ended(before) }
  const isMoved = seen !== undefined && (seen.time - seen.band <= told.by - SHIFT || seen.time >= told.time + SHIFT)
  if (seen && before.pushes < MAX_PUSHES && (isGone(seen) || isMoved)) {
    const pushed = { ...before, pushes: before.pushes + 1 }
    return { watched: isGone(seen) ? ended(pushed) : { ...pushed, told: { time: seen.time, by: seen.time - seen.band }, next: now + FOLLOW }, push: "update" }
  }
  if (isGone(seen) || (seen === undefined && now > told.time + GONE))
    return { watched: ended(before) }
  return { watched: { ...before, next: now + FOLLOW } }
}
