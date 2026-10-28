import { test, expect } from "vitest"
import fc from "fast-check"
import {
  type Kept, type Leg, type Reminder, HEADS_UP, HEADS_UPS, MAX_LEAD, MIN_LEAD, NOT_LIVE, STATES, TOO_SOON,
  delayOf, firstRide, isCurrent, isTooSoon, leadTime, leaveAt, meaningOf, reminderOf, replanned, textOf, walkOf, watchOf
} from "../../src/reminders/reminder.mts"
import { type Wake, KINDS, WAKE_VERSION, pushOf } from "../../src/reminders/watch.mts"
import { emptyModel } from "../../src/transit/models/model.mts"
import { BOARDING, type Run, buildRuns, slack as boardingSlack } from "../../src/transit/models/forecast.mts"
import { type Itinerary, type RideLeg, type WalkLeg, wayKey } from "../../src/routing/plan.mts"
import { walkAllowance, walkSeconds } from "../../src/routing/walks.mts"
import type { Place } from "../../src/places/search.mts"
import { recordedFeed } from "../map/fixtures/recording.mts"

const NOW = 1_790_000_000
const TRIP = "3B FULL_T04"

const ride: fc.Arbitrary<Leg> = fc.record({
  kind:      fc.constant("ride" as const),
  trip:      fc.constant(TRIP),
  route:     fc.constant("3"),
  stop:      fc.constant("101"),
  routeName: fc.constantFrom("3", "WE"),
  stopName:  fc.constantFrom("Kingsbury Hall", "Durham Transportation Center"),
  scheduled: fc.integer({ min: NOW - 600, max: NOW + 7200 }),
  expected:  fc.integer({ min: NOW - 600, max: NOW + 7200 }),
  isLive:    fc.boolean()
})
const walk: fc.Arbitrary<Leg> = fc.record({ kind: fc.constant("walk" as const), walk: fc.integer({ min: 0, max: 1800 }), to: fc.constantFrom("Kingsbury Hall", "Holloway Commons", "MUB") })

/** A kept reminder of any shape: walked the whole way, a walk and a bus, buses with a change, with or without a walk between */
const reminder: fc.Arbitrary<Kept> = fc.record({
  id:      fc.constant("r1"),
  from:    fc.constant({ lat: 43.13, lon: -70.93, name: "Kingsbury Hall" }),
  to:      fc.constantFrom({ lat: 43.13, lon: -70.93, name: "Holloway Commons" }, { lat: 43.14, lon: -70.94, name: "MUB" }),
  way:     fc.constant("w"),
  legs:    fc.oneof(
    fc.tuple(walk),
    fc.tuple(walk, ride, walk),
    fc.tuple(walk, ride, ride, walk),
    fc.tuple(walk, ride, walk, ride, walk)
  ).map(legs => legs as Leg[]),
  start:   fc.integer({ min: NOW - 600, max: NOW + 7200 }),
  end:     fc.integer({ min: NOW, max: NOW + 9000 }),
  by:      fc.option(fc.integer({ min: NOW, max: NOW + 9000 }), { nil: undefined }),
  headsUp: fc.constantFrom(...HEADS_UPS),
  margin:  fc.option(fc.integer({ min: -600, max: 3600 }), { nil: undefined }),
  state:   fc.constantFrom(...STATES)
}).map(({ by, margin, ...rest }) => ({ ...rest, ...by !== undefined && { by }, ...margin !== undefined && { margin } }))

const wake: fc.Arbitrary<Wake> = fc.record({
  v:        fc.constant(WAKE_VERSION),
  reminder: fc.constant("r1"),
  kind:     fc.constantFrom(...KINDS),
  seen:     fc.record({ time: fc.integer({ min: NOW - 600, max: NOW + 7200 }), band: fc.integer({ min: 0, max: 900 }), isLive: fc.boolean(), status: fc.constantFrom("coming" as const, "cancelled" as const, "lost" as const, "passed" as const) }),
  at:       fc.constant(NOW)
})

// The recording's timetable, and itineraries on its route 3 as the planner makes them
const feed = recordedFeed
const runs = buildRuns(feed, "2026-10-07", undefined, emptyModel())
const run = runs.find(run => run.trip.id === TRIP && run.base === 1791345600)!
const place = (index: number): Place => ({ lat: feed.stops[index].lat, lon: feed.stops[index].lon, name: `Near ${feed.stops[index].name}` })
const HOLLOWAY: Place = { lat: 43.13, lon: -70.93, name: "Holloway Commons" }

/** A walk of some meters along the network, leaving at a time */
const walkLeg = (from: Place, to: Place, start: number, meters: number): WalkLeg =>
  ({ kind: "walk", from, to, start, end: start + walkSeconds(meters), meters, via: "network" })

/** A ride on a run between two positions */
const rideLeg = (run: Run, fromPosition: number, toPosition: number): RideLeg =>
  ({ kind: "ride", run, fromPosition, toPosition, start: run.departures[fromPosition], end: run.arrivals[toPosition] })

/** Legs as an itinerary, which starts with the first and ends with the last */
const itineraryOf = (legs: Itinerary["legs"]): Itinerary =>
  ({ legs, start: legs[0].start, end: legs.at(-1)!.end })

/** The planner's shapes: walked the whole way, a walk and a bus, buses with a change and a walk between, and a long walk then a bus */
const shapes = (() => {
  const first = rideLeg(run, 25, 30)
  const stopOf = (leg: RideLeg, position: number) => place(leg.run.trip.stops[position])
  const later = runs.find(other => other.trip.route === "3" && other !== run && other.trip.stops.length > 30 && other.departures[25] > first.end + 300 && other.departures[25] < first.end + 7200)!
  const walkThere = (leg: RideLeg, meters: number) => walkLeg(place(run.trip.stops[20]), stopOf(leg, leg.fromPosition), leg.start - walkAllowance(meters, "network") - 60, meters)
  const walkOn = (leg: RideLeg) => walkLeg(stopOf(leg, leg.toPosition), HOLLOWAY, leg.end, 150)
  return {
    walked:  itineraryOf([walkLeg(place(run.trip.stops[20]), HOLLOWAY, NOW, 1200)]),
    bus:     itineraryOf([walkThere(first, 300), first, walkOn(first)]),
    change:  itineraryOf([walkThere(first, 300), first, walkLeg(stopOf(first, 30), stopOf({ ...first, run: later }, 25), first.end, 100), rideLeg(later, 25, 30), walkOn(rideLeg(later, 25, 30))]),
    longWalk: itineraryOf([walkThere(first, 2000), first, walkOn(first)])
  }
})()

test("a lead is a whole half minute within its bounds that leaves the walk and the heads-up whenever it fits, never later for a longer walk or no bus out, and the heads-up alone for a fixed time", () => {
  fc.assert(fc.property(fc.double({ min: 0, max: 4000, noNaN: true }), fc.boolean(), fc.double({ min: 0, max: 600, noNaN: true }), fc.constantFrom(...HEADS_UPS), (walk, isLive, more, headsUp) => {
    const lead = leadTime({ walk, isLive, headsUp })
    expect(lead % 30).toBe(0)
    expect(lead).toBeGreaterThanOrEqual(MIN_LEAD)
    expect(lead).toBeLessThanOrEqual(MAX_LEAD)
    const needed = walk + headsUp + (isLive ? 0 : NOT_LIVE)
    if (needed <= MAX_LEAD)
      expect(lead - needed).toBeGreaterThanOrEqual(0)
    expect(lead - needed).toBeLessThan(needed <= MAX_LEAD ? 30 : 0.001)
    expect(leadTime({ walk: walk + more, isLive, headsUp })).toBeGreaterThanOrEqual(lead)
    expect(leadTime({ walk, isLive: false, headsUp })).toBeGreaterThanOrEqual(leadTime({ walk, isLive: true, headsUp }))
    expect(leadTime({ walk: 0, isLive: true, headsUp })).toBe(Math.max(MIN_LEAD, headsUp))
  }))
  // A 2-minute walk to a bus out now: the walk and the heads-up; the slack its time needs is the Worker's to allow
  expect(leadTime({ walk: 120, isLive: true, headsUp: HEADS_UP })).toBe(120 + 300)
})

test("a reminder is the trip leg by leg, each walk with its allowance, the first bus by its run and stop, where it's from and to, and when to leave and get there", () => {
  const { bus } = shapes
  const [there, ride, on] = bus.legs as [WalkLeg, RideLeg, WalkLeg]
  expect(reminderOf(feed, bus, "r1", NOW)).toEqual({
    id:   "r1",
    from: there.from,
    to:   HOLLOWAY,
    way:  `${there.from.lat},${there.from.lon}>${there.to.lat},${there.to.lon} ${TRIP}@1791345600:25-30 ${on.from.lat},${on.from.lon}>${HOLLOWAY.lat},${HOLLOWAY.lon}`,
    legs: [
      { kind: "walk", walk: walkAllowance(300, "network"), to: there.to.name },
      { kind: "ride", trip: TRIP, route: "3", stop: "209", routeName: "3", stopName: "Central Avenue @ New York Street", scheduled: 1791397860, expected: run.departures[25], isLive: false },
      { kind: "walk", walk: walkAllowance(150, "network"), to: "Holloway Commons" }
    ],
    start:   bus.start,
    end:     bus.end,
    headsUp: HEADS_UP
  })
  expect(reminderOf(feed, bus, "r2", NOW, { headsUp: 900, by: bus.end + 300 })).toMatchObject({ headsUp: 900, by: bus.end + 300, margin: 300 })
  expect(reminderOf(feed, { ...bus, legs: [{ ...there, from: { ...there.from, isYou: true } }, ride, on] }, "r3", NOW).from).toEqual({ ...there.from, isYou: true })
})

test("a reminder's leave time is the itinerary's own start, whatever its shape: walked the whole way, a walk and a bus, buses with a change, a long walk then a bus", () => {
  for (const [shape, itinerary] of Object.entries(shapes)) {
    const reminder = reminderOf(feed, itinerary, shape, NOW)
    expect(reminder.start).toBe(itinerary.start)
    expect(reminder.end).toBe(itinerary.end)
    expect(reminder.legs.filter(leg => leg.kind === "ride")).toHaveLength(itinerary.legs.filter(leg => leg.kind === "ride").length)
    const [first] = itinerary.legs as [WalkLeg]
    expect(walkOf(reminder)).toBe(walkAllowance(first.meters, first.via))
    // Pushed the bus's time as planned with the slack the plan left it, the phone says to leave as planned
    const ride = itinerary.legs.find(leg => leg.kind === "ride")
    if (ride)
      expect(leaveAt(reminder, ride.start, ride.start - first.start - walkOf(reminder))).toBe(itinerary.start)
    else
      expect(leaveAt(reminder, itinerary.start, 0)).toBe(itinerary.start)
  }
})

test("a watch wakes the phone no later than the heads-up before leaving, however the lead is chosen, and a longer walk never moves the wake later", () => {
  fc.assert(fc.property(reminder, fc.integer({ min: 0, max: 900 }), fc.integer({ min: 0, max: 1800 }), (reminder, band, more) => {
    const watch = watchOf(reminder)
    const ride = firstRide(reminder)
    expect(watch.run).toEqual(ride && { stop: ride.stop, route: ride.route, trip: ride.trip })
    expect(watch.at).toBe(ride ? ride.scheduled : reminder.start)
    // The Worker wakes the phone the lead before the time it foretells, less its band
    const seenBand = ride ? band : 0
    const wake = watch.at - seenBand - watch.lead
    const leave = leaveAt(reminder, watch.at, seenBand)
    if (watch.lead < MAX_LEAD)
      expect(wake).toBeLessThanOrEqual(leave - reminder.headsUp)
    const [first, ...rest] = reminder.legs
    const longer: Kept = { ...reminder, legs: first.kind === "walk" ? [{ ...first, walk: first.walk + more }, ...rest] : reminder.legs }
    expect(watchOf(longer).lead).toBeGreaterThanOrEqual(watch.lead)
  }))
})

test("bus in 10 min, 8 min walk, 1 min band: the phone wakes at least the heads-up before the leave time, whatever heads-up is chosen, and the trip is too soon to remind of", () => {
  const walk = walkAllowance(8 * 60 * 1.3, "network")
  const kept = (headsUp: number): Reminder => ({
    id: "r1", from: { lat: 0, lon: 0, name: "Here" }, to: { lat: 0, lon: 0, name: "MUB" }, way: "w",
    legs: [{ kind: "walk", walk, to: "Kingsbury Hall" }, { kind: "ride", trip: TRIP, route: "3", stop: "101", routeName: "3", stopName: "Kingsbury Hall", scheduled: NOW + 600, expected: NOW + 600, isLive: true }, { kind: "walk", walk: 60, to: "MUB" }],
    start: NOW + 600 - 60 - walk, end: NOW + 1200, headsUp
  })
  const wakes = HEADS_UPS.map(headsUp => {
    const reminder = kept(headsUp)
    const { at, lead } = watchOf(reminder)
    const wake = at - 60 - lead
    const leave = leaveAt(reminder, at, 60)
    expect(leave).toBe(reminder.start)
    expect(wake).toBeLessThanOrEqual(leave - headsUp)
    expect(isTooSoon(reminder, NOW)).toBe(true)
    return leave - wake
  })
  // Default: the 8 min walk and 5 min heads-up, to the half minute; 2 min: no later than 2 min before leaving
  expect(wakes).toEqual([120, 300, 600, 900].map(headsUp => Math.ceil((walk + headsUp) / 30) * 30 - walk))
  expect(isTooSoon({ start: NOW + 600 + HEADS_UP + TOO_SOON + 1, headsUp: HEADS_UP }, NOW)).toBe(false)
})

test("a reminder is listed while its trip is still to end and it isn't being cancelled, and once either is past it's not", () => {
  fc.assert(fc.property(reminder, fc.integer({ min: NOW - 600, max: NOW + 10_000 }), (kept, now) => {
    expect(isCurrent(kept, now)).toBe(kept.state !== "cancelling" && kept.end > now)
    expect(isCurrent({ ...kept, state: "cancelling" }, now)).toBe(false)
    expect(isCurrent({ ...kept, state: "set" }, kept.end)).toBe(false)
    expect(isCurrent({ ...kept, state: "set" }, kept.end - 1)).toBe(true)
  }))
})

test("a trip to leave for within the heads-up and a minute is too soon to remind of, and one later isn't", () => {
  fc.assert(fc.property(fc.integer({ min: -3600, max: 7200 }), fc.constantFrom(...HEADS_UPS), (ahead, headsUp) => {
    expect(isTooSoon({ start: NOW + ahead, headsUp }, NOW)).toBe(ahead <= headsUp + TOO_SOON)
  }))
})

test("a walk-only reminder watches no run, and wakes at the heads-up before leaving", () => {
  fc.assert(fc.property(fc.integer({ min: NOW, max: NOW + 7200 }), fc.integer({ min: 100, max: 3000 }), fc.constantFrom(...HEADS_UPS), (start, meters, headsUp) => {
    const walked = itineraryOf([walkLeg(place(run.trip.stops[20]), HOLLOWAY, start, meters)])
    const reminder = reminderOf(feed, walked, "r1", NOW, { headsUp })
    expect(firstRide(reminder)).toBeUndefined()
    expect(reminder.margin).toBeUndefined()
    const watch = watchOf(reminder)
    expect(watch).toEqual({ at: start, lead: Math.max(MIN_LEAD, headsUp) })
    expect(watch.at - watch.lead).toBeLessThanOrEqual(start - headsUp)
    expect(leaveAt(reminder, start, 0)).toBe(start)
  }))
})

test("the margin is the least of each change's slack and of what's left before `by`, and a first bus later than it says to open notunh rather than when you'll get there", () => {
  const { change } = shapes
  const [, first, between, second] = change.legs as [WalkLeg, RideLeg, WalkLeg, RideLeg, WalkLeg]
  // The change's slack is what the planner counts on: the time to the next bus, less the walk and the slack the
  // next bus's own time needs
  const slack = second.start - boardingSlack(second.run, second.fromPosition, second.start, NOW) - first.end - walkAllowance(between.meters, between.via)
  expect(boardingSlack(second.run, second.fromPosition, second.start, NOW)).toBeGreaterThanOrEqual(BOARDING)
  expect(reminderOf(feed, change, "r1", NOW).margin).toBe(slack)
  expect(reminderOf(feed, change, "r1", NOW, { by: change.end + 60 }).margin).toBe(Math.min(slack, 60))
  expect(reminderOf(feed, change, "r1", NOW, { by: change.end + 7200 }).margin).toBe(slack)
  expect(reminderOf(feed, shapes.bus, "r1", NOW).margin).toBeUndefined()

  const kept: Kept = { ...reminderOf(feed, change, "r1", NOW), state: "set" }
  const pushed = (delay: number) => textOf({ v: WAKE_VERSION, reminder: "r1", kind: "due", seen: { time: first.start + delay, band: 60, isLive: true, status: "coming" }, at: NOW }, kept, first.start - 1200)
  expect(delayOf(kept, first.start + slack)).toEqual({ delay: slack, holds: true })
  expect(delayOf(kept, first.start + slack + 1)).toEqual({ delay: slack + 1, holds: false })
  expect(pushed(slack).body).toContain("Holloway Commons")
  expect(pushed(slack).body).not.toContain("open notunh")
  expect(pushed(slack + 60).body).toContain("may miss the")
  expect(pushed(slack + 60).body).toContain("Open notunh")
  const late: Kept = { ...reminderOf(feed, shapes.bus, "r1", NOW, { by: shapes.bus.end + 120 }), state: "set" }
  expect(textOf({ v: WAKE_VERSION, reminder: "r1", kind: "due", seen: { time: first.start + 300, band: 60, isLive: true, status: "coming" }, at: NOW }, late, NOW).body).toContain("may be late for")
})

test("a push means leaving for the bus where it's foretold, with how early to be there, that it's missing once it's cancelled, past, or was gone before it was near, or that it's lost to a changed timetable", () => {
  fc.assert(fc.property(wake, wake => {
    const meaning = meaningOf(wake)
    if (wake.seen.status === "lost")
      expect(meaning).toEqual({ kind: "lost" })
    else if (wake.kind === "over" || wake.seen.status !== "coming")
      expect(meaning).toEqual({ kind: "missing" })
    else
      expect(meaning).toEqual({ kind: wake.kind === "update" ? "update" : "leave", eta: wake.seen.time, band: wake.seen.band, isLive: wake.seen.isLive })
  }))
})

test("every push says something, a walk-only one names the walk, and where the trip goes is said only by the phone, never put in what the Worker sends", () => {
  fc.assert(fc.property(wake, fc.option(reminder, { nil: undefined }), (wake, reminder) => {
    const { title, body } = textOf(wake, reminder, NOW)
    expect(title.length * body.length).toBeGreaterThan(0)
    if (!reminder)
      return
    expect(pushOf(wake)).not.toContain(reminder.to.name)
    expect(JSON.stringify(watchOf(reminder))).not.toContain(reminder.to.name)
    // One cancelled here, which the Worker hasn't heard of yet, says so rather than when to leave
    if (reminder.state === "cancelling") {
      expect(title).toBe("Reminder cancelled")
      return
    }
    expect(body).toContain(reminder.to.name)
    const meaning = meaningOf(wake)
    if (meaning.kind === "missing" || meaning.kind === "lost")
      return
    const leave = leaveAt(reminder, meaning.eta, meaning.band)
    expect(meaning.eta - leave).toBe(firstRide(reminder) ? walkOf(reminder) + meaning.band : 0)
    if (!firstRide(reminder))
      expect(body).toMatch(/^\d+ min walk to /)
    if (meaning.kind === "leave")
      expect(title).toBe(leave - NOW < 60 ? "Leave now" : `Leave in ${Math.max(1, Math.round((leave - NOW) / 60))} min`)
  }))
  const kept: Kept = {
    id: "r1", from: { lat: 0, lon: 0, name: "Here" }, to: { lat: 0, lon: 0, name: "MUB" }, way: "w",
    legs: [{ kind: "walk", walk: 240, to: "Kingsbury Hall" }, { kind: "ride", trip: TRIP, route: "3", stop: "101", routeName: "3", stopName: "Kingsbury Hall", scheduled: NOW + 540, expected: NOW + 600, isLive: true }, { kind: "walk", walk: 120, to: "MUB" }],
    start: NOW + 300, end: NOW + 1200, headsUp: HEADS_UP, state: "set"
  }
  expect(textOf({ v: WAKE_VERSION, reminder: "r1", kind: "update", seen: { time: NOW + 900, band: 120, isLive: true, status: "coming" }, at: NOW }, kept, NOW)).toEqual({
    title: "Bus 3 now 10:28 AM",
    // 15 minutes out, less the 4-minute walk and 2 minutes of band, and there 5 minutes later than planned
    body:  "Leave in 9 min · Bus 3 at Kingsbury Hall 10:28 AM (5 min late) · 4 min walk · MUB 10:38 AM"
  })
  expect(textOf({ v: WAKE_VERSION, reminder: "r1", kind: "due", seen: { time: NOW + 600, band: 60, isLive: false, status: "coming" }, at: NOW }, { ...kept, by: NOW + 1500 }, NOW)).toEqual({
    title: "Leave in 5 min",
    body:  "Bus 3 at Kingsbury Hall 10:23 AM (scheduled) · 4 min walk · MUB 10:33 AM, before your 10:38 AM"
  })
  expect(textOf({ v: WAKE_VERSION, reminder: "r1", kind: "due", seen: { time: NOW + 600, band: 60, isLive: false, status: "cancelled" }, at: NOW }, kept, NOW)).toEqual({
    title: "Bus 3 may not be coming",
    body:  "notunh doesn't see the 10:23 AM at Kingsbury Hall. Open notunh for another way to MUB."
  })
  expect(textOf({ v: WAKE_VERSION, reminder: "r1", kind: "over", seen: { time: NOW + 540, band: 60, isLive: false, status: "lost" }, at: NOW }, kept, NOW)).toEqual({
    title: "notunh lost track of this trip",
    body:  "The timetable changed since you set a reminder for MUB. Open notunh for another way to MUB."
  })
  const walked: Kept = { ...kept, legs: [{ kind: "walk", walk: 840, to: "MUB" }], start: NOW + 300, end: NOW + 1140 }
  expect(textOf({ v: WAKE_VERSION, reminder: "r1", kind: "due", seen: { time: NOW + 300, band: 0, isLive: false, status: "coming" }, at: NOW }, walked, NOW)).toEqual({
    title: "Leave in 5 min",
    body:  "14 min walk to MUB, there 10:32 AM."
  })
})

test("a trip planned again takes its own way where that's still offered, else the best, but none that misses its time to be there by, as the ways fall back to leaving now, nor one too soon to be reminded of", () => {
  const { bus, change } = shapes
  const kept = (itinerary: Itinerary, by?: number): Kept => ({ ...reminderOf(feed, itinerary, "r1", NOW, { headsUp: 900, by }), state: "set" })
  expect(replanned(feed, kept(change), [bus, change], NOW)).toMatchObject({ id: "r1", way: wayKey(change), headsUp: 900 })
  expect(replanned(feed, kept(change), [bus], NOW)?.way).toBe(wayKey(bus))
  expect(replanned(feed, kept(bus), [], NOW)).toBeUndefined()
  expect(replanned(feed, kept(bus, bus.end + 60), [bus], NOW)).toMatchObject({ by: bus.end + 60 })
  expect(replanned(feed, kept(bus, bus.end - 60), [bus], NOW)).toBeUndefined()
  expect(replanned(feed, kept(bus), [bus], bus.start - 900 - TOO_SOON - 1)).toBeDefined()
  expect(replanned(feed, kept(bus), [bus], bus.start - 900 - TOO_SOON)).toBeUndefined()
})
