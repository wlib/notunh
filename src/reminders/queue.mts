// A class reminder's queue: a reminder for a section's next meeting, and the visits after it, resolved to a time and
// a place each and kept with it on the phone (reminder.mts), so the service worker can go on to the next without the
// courses. The Worker watches one at a time, as it does a trip, and never learns there's a class, let alone which.
// When a push for the current visit comes, or its time has passed unheard, the phone moves on to the next, not
// planned yet, and sets it with the Worker under the same id. Opening a page tops the queue up from the section as
// it stands, so a room or time changed, or a meeting dropped, replaces what's queued. The queue ends at the section's
// last meeting, and one drained before that, as offline for weeks, says so in its last push

import type { Visit } from "../shared/visit.mts"
import { isSameOccasion, thereBy } from "../shared/visit.mts"
import type { Wake } from "./watch.mts"
import { type Kept, type Reminder, type Target, unplanned } from "./reminder.mts"

/** Visits a class reminder holds, the one it's for among them: two weeks of a class three times a week, and some */
export const QUEUE_SIZE = 10

/** A section's meetings still to come, soonest first, as visits at no offset, to its last meeting: what the courses give a queue, by the section's id, or nothing while its term is still to load */
export type Resolver = (section: string) => Visit[] | undefined

/** Where a visit is on the map, or nowhere it knows */
export type Locate = (visit: Visit) => Reminder["to"] | undefined

/**
 * The targets a section's visits make, as of epoch seconds `now`: those still to be got to, by the offset asked,
 * where the map knows them, soonest first, up to `size`, and whether those reach the last meeting
 */
export const targetsOf = (visits: readonly Visit[], offset: number, locate: Locate, now: number, size = QUEUE_SIZE) => {
  const ahead = visits
    .map(visit => ({ ...visit, offset }))
    .filter(visit => thereBy(visit) > now * 1000)
    .toSorted((a, b) => thereBy(a) - thereBy(b))
  const targets = ahead.slice(0, size).flatMap((visit): Target[] => {
    const to = locate(visit)
    return to ? [{ visit, to }] : []
  })
  return { targets, complete: ahead.length <= size }
}

/** A reminder moved on to a target not planned yet, to be set with the Worker under its id, and the queue after it */
const movedTo = (kept: Kept, [target, ...next]: Target[], complete: boolean, now: number): Kept => {
  const queue = kept.queue!
  return { ...unplanned(kept.id, kept.from, target, queue.travel, kept.headsUp), state: "setting", queue: { ...queue, next, complete, since: now } }
}

/** Whether a reminder is done with the visit it's for: told of it, or past it */
const isDone = (kept: Kept, now: number) =>
  kept.last !== undefined || kept.end <= now

/**
 * A class reminder as of epoch seconds `now`, moved on from the visit it's for to the next still to come, once a push
 * of it came (`wake`) or it's done with; else as it was. A push from before the current visit was moved on to is of
 * one gone before, so going on is idempotent, a queue drained stays on its last, and one being cancelled stays so
 */
export const movedOn = (kept: Kept, now: number, wake?: Wake): Kept => {
  const queue = kept.queue
  if (!queue || kept.state === "cancelling" || (wake ? wake.at <= queue.since : !isDone(kept, now)))
    return kept
  const next = queue.next.filter(({ visit }) => thereBy(visit) > now * 1000)
  return next.length ? movedTo(kept, next, queue.complete, now) : kept
}

/**
 * A class reminder topped up from its section's visits as they stand, as of epoch seconds `now`: the queue replaced
 * by them, and the visit it's for too where that's no longer the next, as for a room or time changed, set with the
 * Worker under the same id. One whose section has nothing left keeps its last visit, which ends it, and one being
 * cancelled stays so
 */
export const toppedUp = (kept: Kept, visits: readonly Visit[], locate: Locate, now: number): Kept => {
  if (!kept.queue || !kept.visit || kept.state === "cancelling")
    return kept
  const isCurrent = (target: Target) => isSameOccasion(target.visit, kept.visit!)
  const { targets, complete } = targetsOf(visits, kept.visit.offset, locate, now)
  // Once told of, or past, the visit it's for is done, and the next is another
  const ahead = isDone(kept, now) ? targets.filter(target => !isCurrent(target)) : targets
  if (!ahead.length)
    return { ...kept, queue: { ...kept.queue, next: [], complete: true } }
  const [first, ...next] = ahead
  return isCurrent(first)
    ? { ...kept, queue: { ...kept.queue, next, complete } }
    : movedTo(kept, ahead, complete, now)
}

/** A class reminder's queue to begin with, after the visit it's set for, from its section's visits as of epoch seconds `now` */
export const queueOf = (reminder: Reminder, section: string, visits: readonly Visit[], locate: Locate, now: number) => {
  const offset = reminder.visit?.offset ?? 0
  const after = Math.max(reminder.end * 1000, reminder.visit ? thereBy(reminder.visit) : 0)
  const { targets: next, complete } = targetsOf(visits.filter(visit => thereBy({ ...visit, offset }) > after), offset, locate, now, QUEUE_SIZE - 1)
  return {
    section,
    next,
    complete,
    travel: reminder.end - reminder.start,
    since:  now
  }
}
