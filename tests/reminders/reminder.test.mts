import { test, expect } from "vitest"
import fc from "fast-check"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { type Kept, HEADS_UP, MAX_LEAD, MIN_LEAD, NOT_LIVE, STATES, leadTime, leaveAt, meaningOf, reminderOf, textOf, watchOf } from "../../src/reminders/reminder.mts"
import { type Wake, KINDS, WAKE_VERSION, pushOf } from "../../src/reminders/watch.mts"
import { type FeedData, withIndexes } from "../../src/transit/feed.mts"
import { emptyModel } from "../../src/transit/models/model.mts"
import { buildRuns } from "../../src/transit/models/forecast.mts"
import type { Itinerary } from "../../src/routing/plan.mts"

const NOW = 1_790_000_000
const TRIP = "3B FULL_T04"

const reminder: fc.Arbitrary<Kept> = fc.record({
  id:        fc.constant("r1"),
  trip:      fc.constant(TRIP),
  route:     fc.constant("3"),
  stop:      fc.constant("101"),
  routeName: fc.constantFrom("3", "WE"),
  stopName:  fc.constantFrom("Kingsbury Hall", "Durham Transportation Center"),
  scheduled: fc.integer({ min: NOW - 600, max: NOW + 7200 }),
  expected:  fc.integer({ min: NOW - 600, max: NOW + 7200 }),
  walk:      fc.integer({ min: 0, max: 1800 }),
  lead:      fc.integer({ min: 60, max: 3600 }),
  to:        fc.constantFrom("Holloway Commons", "MUB"),
  arrival:   fc.integer({ min: NOW, max: NOW + 9000 }),
  state:     fc.constantFrom(...STATES)
})

const wake: fc.Arbitrary<Wake> = fc.record({
  v:        fc.constant(WAKE_VERSION),
  reminder: fc.constant("r1"),
  kind:     fc.constantFrom(...KINDS),
  seen:     fc.record({ time: fc.integer({ min: NOW - 600, max: NOW + 7200 }), band: fc.integer({ min: 30, max: 900 }), isLive: fc.boolean(), status: fc.constantFrom("coming" as const, "cancelled" as const, "lost" as const, "passed" as const) }),
  at:       fc.constant(NOW)
})

// The timetable of tests/map/replay.test.mts, and an itinerary on its route 3 as the planner makes one
const { feed: data }: { feed: FeedData } = JSON.parse(gunzipSync(readFileSync(new URL("../map/fixtures/buses.json.gz", import.meta.url))).toString())
const feed = withIndexes(data)
const run = buildRuns(feed, "2026-10-07", undefined, emptyModel()).find(run => run.trip.id === TRIP && run.base === 1791345600)!
const place = (index: number) => ({ lat: feed.stops[index].lat, lon: feed.stops[index].lon, name: `Near ${feed.stops[index].name}` })
const itinerary: Itinerary = {
  legs: [
    { kind: "walk", from: place(run.trip.stops[20]), to: place(run.trip.stops[25]), start: run.departures[25] - 400, end: run.departures[25] - 100, meters: 300 },
    { kind: "ride", run, fromPosition: 25, toPosition: 30, start: run.departures[25], end: run.arrivals[30] },
    { kind: "walk", from: place(run.trip.stops[30]), to: { lat: 43.13, lon: -70.93, name: "Holloway Commons" }, start: run.arrivals[30], end: run.arrivals[30] + 120, meters: 150 }
  ],
  start: run.departures[25] - 400,
  end:   run.arrivals[30] + 120
}

test("a lead is a whole half minute within its bounds that leaves the walk and the heads-up whenever it fits, never later for a longer walk or no bus out, and as chosen when chosen", () => {
  fc.assert(fc.property(fc.double({ min: 0, max: 4000, noNaN: true }), fc.boolean(), fc.double({ min: 0, max: 600, noNaN: true }), fc.integer({ min: 2, max: 120 }), (walk, isLive, more, halves) => {
    const lead = leadTime({ walk, isLive })
    expect(lead % 30).toBe(0)
    expect(lead).toBeGreaterThanOrEqual(MIN_LEAD)
    expect(lead).toBeLessThanOrEqual(MAX_LEAD)
    const needed = walk + HEADS_UP + (isLive ? 0 : NOT_LIVE)
    if (needed <= MAX_LEAD)
      expect(lead - needed).toBeGreaterThanOrEqual(0)
    expect(lead - needed).toBeLessThan(needed <= MAX_LEAD ? 30 : 0.001)
    expect(leadTime({ walk: walk + more, isLive })).toBeGreaterThanOrEqual(lead)
    expect(leadTime({ walk, isLive: false })).toBeGreaterThanOrEqual(leadTime({ walk, isLive: true }))
    expect(leadTime({ walk, isLive, override: halves * 30 })).toBe(Math.min(MAX_LEAD, Math.max(MIN_LEAD, halves * 30)))
  }))
  // A 2-minute walk to a bus out now: the walk and the heads-up; the slack its time needs is the Worker's to allow
  expect(leadTime({ walk: 120, isLive: true })).toBe(120 + 300)
})

test("a reminder is the itinerary's first bus at its stop, the walk there without the wait, and where the trip ends, and none for a walk alone", () => {
  expect(reminderOf(feed, itinerary, "r1")).toEqual({
    id: "r1", trip: TRIP, route: "3", stop: "209", routeName: "3", stopName: "Central Avenue @ New York Street",
    scheduled: 1791397860, expected: run.departures[25], walk: 300, lead: leadTime({ walk: 300, isLive: false }), to: "Holloway Commons", arrival: itinerary.end
  })
  expect(reminderOf(feed, itinerary, "r2", 900)!.lead).toBe(900)
  expect(reminderOf(feed, { ...itinerary, legs: [itinerary.legs[0]] }, "r3")).toBeUndefined()
})

test("the Worker is asked to watch the run, by its trip and scheduled time at the stop, that far ahead, and nothing more", () => {
  fc.assert(fc.property(reminder, reminder => {
    expect(watchOf(reminder)).toEqual({ stop: reminder.stop, route: reminder.route, trip: reminder.trip, scheduled: reminder.scheduled, lead: reminder.lead })
    expect(JSON.stringify(watchOf(reminder))).not.toContain(reminder.to)
  }))
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

test("every push says something, leaving leaves the walk and the band, and where the trip goes is said only by the phone, never put in what the Worker pushes", () => {
  fc.assert(fc.property(wake, fc.option(reminder, { nil: undefined }), (wake, reminder) => {
    const { title, body } = textOf(wake, reminder, NOW)
    expect(title.length * body.length).toBeGreaterThan(0)
    if (!reminder)
      return
    expect(pushOf(wake)).not.toContain(reminder.to)
    // One cancelled here, which the Worker hasn't heard of yet, says so rather than when to leave
    if (reminder.state === "cancelling") {
      expect(title).toBe("Reminder cancelled")
      return
    }
    expect(body).toContain(reminder.to)
    const meaning = meaningOf(wake)
    if (meaning.kind === "missing" || meaning.kind === "lost")
      return
    const leave = leaveAt(reminder, meaning.eta, meaning.band)
    expect(meaning.eta - leave).toBe(reminder.walk + meaning.band)
    if (meaning.kind === "leave")
      expect(title).toBe(leave - NOW < 60 ? "Leave now" : `Leave in ${Math.max(1, Math.round((leave - NOW) / 60))} min`)
  }))
  const kept: Kept = { id: "r1", trip: TRIP, route: "3", stop: "101", routeName: "3", stopName: "Kingsbury Hall", scheduled: NOW + 540, expected: NOW + 600, walk: 240, lead: 600, to: "MUB", arrival: NOW + 1200, state: "set" }
  expect(textOf({ v: WAKE_VERSION, reminder: "r1", kind: "update", seen: { time: NOW + 900, band: 120, isLive: true, status: "coming" }, at: NOW }, kept, NOW)).toEqual({
    title: "Bus 3 is now due at 10:28 AM",
    // 15 minutes out, less the 4-minute walk and 2 minutes of band
    body:  "Leave in 9 min. Bus 3 reaches Kingsbury Hall at 10:28 AM (5 min late), 4 min walk. You'll be at MUB around 10:38 AM."
  })
  expect(textOf({ v: WAKE_VERSION, reminder: "r1", kind: "due", seen: { time: NOW + 600, band: 60, isLive: false, status: "cancelled" }, at: NOW }, kept, NOW)).toEqual({
    title: "Bus 3 may not be coming",
    body:  "notunh doesn't see the 10:23 AM at Kingsbury Hall. Open notunh for another way to MUB."
  })
  expect(textOf({ v: WAKE_VERSION, reminder: "r1", kind: "over", seen: { time: NOW + 540, band: 60, isLive: false, status: "lost" }, at: NOW }, kept, NOW)).toEqual({
    title: "notunh lost track of this bus",
    body:  "The timetable changed since you set a reminder for the 10:23 AM Bus 3 at Kingsbury Hall. Open notunh for another way to MUB."
  })
})
