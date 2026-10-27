// A class reminder's queue (src/reminders/queue.mts) against generated sections: a weekly pattern of days and a time,
// from a first date to a last, with days off, each meeting a visit as the courses would resolve it. However time
// goes on, pushes come or don't, and pages top it up, the queue holds only the section's meetings still to come, to
// its last, and moving on is idempotent

import { test, expect } from "vitest"
import fc from "fast-check"
import { type Kept, type Target, textOf, unplanned, watchOf, LAST_KNOWN } from "../../src/reminders/reminder.mts"
import { QUEUE_SIZE, type Locate, movedOn, queueOf, targetsOf, toppedUp } from "../../src/reminders/queue.mts"
import { type Wake, WAKE_VERSION } from "../../src/reminders/watch.mts"
import { type Visit, isSameOccasion, thereBy } from "../../src/shared/visit.mts"
import { type Day, addDays, atClock, localDay, weekday } from "../../src/shared/time.mts"

const NOW = Math.floor(Date.now() / 1000)
const TODAY = localDay(NOW * 1000)
const HERE = { lat: 43.13, lon: -70.93, name: "Your location", isYou: true as const }
const BUILDINGS: Record<string, { lat: number, lon: number }> = { "Kingsbury Hall": { lat: 43.1361, lon: -70.9353 }, "Pettee Hall": { lat: 43.1340, lon: -70.9365 } }

const locate: Locate = ({ destination: { place } }) =>
  BUILDINGS[place] && { ...BUILDINGS[place], name: place }

/** A section's weekly pattern: its weekdays, time, room, first and last dates, and days it doesn't meet */
type Pattern = { days: number[], time: string, place: string, where: string, first: Day, last: Day, off: Day[] }

const pattern: fc.Arbitrary<Pattern> = fc.record({
  days:  fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 5 }),
  time:  fc.integer({ min: 8 * 12, max: 20 * 12 }).map(fives => `${String(Math.floor(fives / 12)).padStart(2, "0")}:${String(fives % 12 * 5).padStart(2, "0")}`),
  place: fc.constantFrom(...Object.keys(BUILDINGS)),
  where: fc.constantFrom("N343", "N113", "114"),
  start: fc.integer({ min: -40, max: 10 }),
  weeks: fc.integer({ min: 0, max: 16 }),
  off:   fc.uniqueArray(fc.integer({ min: 0, max: 120 }), { maxLength: 12 })
}).map(({ start, weeks, off, ...rest }) => {
  const first = addDays(TODAY, start)
  return { ...rest, first, last: addDays(first, weeks * 7), off: off.map(days => addDays(first, days)) }
})

/** The meetings a pattern makes, every one, as the courses resolve a section, from its first date to its last less its days off */
const meetingsOf = ({ days, time, place, where, first, last, off }: Pattern): Visit[] => {
  const visits: Visit[] = []
  for (let day = first; day <= last; day = addDays(day, 1))
    if (days.includes(weekday(day)) && !off.includes(day))
      visits.push({ destination: { place, where }, arriveBy: atClock(day, time), offset: 0, occurrence: { id: `cs518:${day}`, title: "CS 518" } })
  return visits
}

const wakeAt = (at: number): Wake =>
  ({ v: WAKE_VERSION, reminder: "r1", kind: "due", seen: { time: at, band: 0, isLive: false, status: "coming" }, at })

/** A class reminder set as of `now` for a section's next meeting, by an offset, and its queue */
const setFor = (meetings: Visit[], offset: number, now: number): Kept | undefined => {
  const [first] = targetsOf(meetings, offset, locate, now).targets
  if (!first)
    return
  const reminder = unplanned("r1", HERE, first, 600)
  return { ...reminder, state: "set", queue: queueOf(reminder, "202610:12496", meetings, locate, now) }
}

/** Whether a visit is one of a pattern's meetings, by the offset asked */
const isMeeting = (meetings: Visit[], visit: Visit) =>
  meetings.some(meeting => isSameOccasion(meeting, visit))

/** What a queue holds is its section's meetings, by the offset asked, soonest first, after the one it's for, no more than it may */
const expectSound = (kept: Kept, meetings: Visit[], { last, off }: Pattern) => {
  const visits = [kept.visit!, ...kept.queue!.next.map(({ visit }) => visit)]
  for (const visit of visits) {
    expect(isMeeting(meetings, visit)).toBe(true)
    expect(localDay(visit.arriveBy) <= last).toBe(true)
    expect(off).not.toContain(localDay(visit.arriveBy))
    expect(visit.offset).toBe(kept.visit!.offset)
  }
  for (let i = 1; i < visits.length; i++)
    expect(thereBy(visits[i])).toBeGreaterThan(thereBy(visits[i - 1]))
  expect(kept.queue!.next.length).toBeLessThan(QUEUE_SIZE)
}

/** Time going on, and what may happen meanwhile: a push of the visit it's for, nothing heard, or a page topping it up */
const step = fc.record({ after: fc.integer({ min: 0, max: 4 * 86_400 }), what: fc.constantFrom("push", "quiet", "page"), delay: fc.integer({ min: 1, max: 30 }) })

test("a queue never holds a no-class day or a date past the pattern, however time goes on, pushes come, and pages top it up", () => {
  fc.assert(fc.property(pattern, fc.constantFrom(0, 300_000, 600_000), fc.array(step, { maxLength: 30 }), (section, offset, steps) => {
    const meetings = meetingsOf(section)
    let kept = setFor(meetings, offset, NOW)
    if (!kept)
      return
    let now = NOW
    expectSound(kept, meetings, section)
    for (const { after, what, delay } of steps) {
      now += after
      kept =
        what === "push"  ? movedOn(kept, now, wakeAt(now - delay)) :
        what === "quiet" ? movedOn(kept, now) :
                           toppedUp(kept, meetings, locate, now)
      expectSound(kept, meetings, section)
      // Complete, it holds every meeting still to come after the one it's for
      if (kept.queue!.complete)
        for (const meeting of meetings.map(meeting => ({ ...meeting, offset })))
          if (thereBy(meeting) > Math.max(now * 1000, thereBy(kept.visit!)))
            expect(kept.queue!.next.some(({ visit }) => isSameOccasion(visit, meeting))).toBe(true)
    }
  }), { numRuns: 300 })
})

test("moving on is idempotent: the same push again, or nothing heard again, leaves the queue as it was", () => {
  fc.assert(fc.property(pattern, fc.array(step, { maxLength: 12 }), (section, steps) => {
    const meetings = meetingsOf(section)
    let kept = setFor(meetings, 0, NOW)
    if (!kept)
      return
    let now = NOW
    for (const { after, what, delay } of steps) {
      now += after
      const wake = what === "push" ? wakeAt(now - delay) : undefined
      const once = movedOn(kept, now, wake)
      expect(movedOn(once, now, wake)).toEqual(once)
      // The same push again, later, is of the visit moved on from. Nothing heard later is another matter, as the next
      // visit may have passed by then
      if (wake)
        expect(movedOn(once, now + delay, wake)).toEqual(once)
      // A push moves it on by one visit at most, never past the next
      if (wake && once !== kept && kept.queue!.next.length)
        expect(isSameOccasion(once.visit!, kept.queue!.next.find(({ visit }) => thereBy(visit) > now * 1000)!.visit)).toBe(true)
      kept = once
    }
  }), { numRuns: 300 })
})

test("a class reminder being cancelled never moves on or tops up, which would set it with the Worker again", () => {
  fc.assert(fc.property(pattern, fc.array(step, { maxLength: 12 }), (section, steps) => {
    const meetings = meetingsOf(section)
    const set = setFor(meetings, 0, NOW)
    if (!set)
      return
    const cancelling: Kept = { ...set, state: "cancelling" }
    let now = NOW
    for (const { after, what, delay } of steps) {
      now += after
      expect(movedOn(cancelling, now, what === "push" ? wakeAt(now - delay) : undefined)).toBe(cancelling)
      expect(toppedUp(cancelling, meetings, locate, now)).toBe(cancelling)
    }
  }), { numRuns: 100 })
})

test("a room change replaces the queue, and the visit it's for too where that's changed, under the same id, to be set with the Worker again", () => {
  fc.assert(fc.property(pattern, fc.constantFrom("N101", "G05"), fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 3 * 86_400 }), (section, room, from, after) => {
    const meetings = meetingsOf(section)
    const kept = setFor(meetings, 300_000, NOW)
    if (!kept)
      return
    // From some day on, it meets in another room
    const changed = meetingsOf(section).map(visit => localDay(visit.arriveBy) >= addDays(TODAY, from) ? { ...visit, destination: { ...visit.destination, where: room } } : visit)
    const now = NOW + after
    const topped = toppedUp(kept, changed, locate, now)
    const { targets } = targetsOf(changed, 300_000, locate, now)
    const isDone = kept.end <= now
    const ahead = isDone ? targets.filter(({ visit }) => !isSameOccasion(visit, kept.visit!)) : targets
    if (!ahead.length) {
      expect(topped.queue!.next).toEqual([])
      return
    }
    // What's queued is the section as it is now, the visit it's for first
    expect([topped.visit, ...topped.queue!.next.map(({ visit }) => visit)]).toEqual(ahead.map(({ visit }) => visit))
    expect(topped.id).toBe(kept.id)
    const isSame = isSameOccasion(ahead[0].visit, kept.visit!)
    expect(topped.state).toBe(isSame ? "set" : "setting")
    if (!isSame)
      expect(topped.queue!.since).toBe(now)
  }), { numRuns: 300 })
})

test("a queue drained before the section ends says so in its last push, and one that reached the last meeting doesn't", () => {
  const section: Pattern = { days: [0, 1, 2, 3, 4, 5, 6], time: "14:10", place: "Kingsbury Hall", where: "N343", first: addDays(TODAY, 1), last: addDays(TODAY, 40), off: [] }
  const meetings = meetingsOf(section)
  let kept = setFor(meetings, 0, NOW)!
  expect(kept.queue).toMatchObject({ complete: false })
  expect(kept.queue!.next).toHaveLength(QUEUE_SIZE - 1)
  // Each push moves it on, offline the whole time, until only the last it knows of is left
  for (let i = 0; i < QUEUE_SIZE - 1; i++) {
    const now = kept.start
    expect(textOf(wakeAt(now), kept, now).body).not.toContain(LAST_KNOWN)
    kept = movedOn(kept, now + 1, wakeAt(now))
  }
  expect(kept.queue!.next).toEqual([])
  expect(textOf(wakeAt(kept.start), kept, kept.start).body).toContain(LAST_KNOWN)
  expect(movedOn(kept, kept.start + 1, wakeAt(kept.start))).toBe(kept)
  // A section with fewer meetings left than a queue holds ends at its last, which says nothing more
  const short = setFor(meetingsOf({ ...section, last: addDays(TODAY, 3) }), 0, NOW)!
  expect(short.queue).toMatchObject({ complete: true })
  const last = short.queue!.next.reduce(kept => movedOn(kept, kept.start + 1, wakeAt(kept.start)), short)
  expect(textOf(wakeAt(last.start), last, last.start).body).not.toContain(LAST_KNOWN)
})

test("the Worker is asked to watch a time and a lead alone for a class's visit, never what or where", () => {
  fc.assert(fc.property(pattern, fc.integer({ min: 0, max: 600 }), (section, travel) => {
    const [target] = targetsOf(meetingsOf(section), 0, locate, NOW).targets as (Target | undefined)[]
    if (!target)
      return
    const watch = watchOf(unplanned("r1", HERE, target, travel))
    expect(Object.keys(watch)).toEqual(["at", "lead"])
    expect(watch.at).toBe(Math.round(thereBy(target.visit) / 1000) - travel)
    expect(Object.values(watch).every(value => typeof value === "number")).toBe(true)
  }))
})
