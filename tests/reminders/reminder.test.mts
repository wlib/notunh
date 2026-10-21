import { test, expect } from "vitest"
import fc from "fast-check"
import { type Reminder, HEADS_UP, MAX_LEAD, MIN_LEAD, NOT_LIVE, leadTime, leaveAt, meaningOf, textOf, watchOf } from "../../src/reminders/reminder.mts"
import { type Wake, KINDS, pushOf } from "../../src/reminders/watch.mts"

const NOW = 1_790_000_000
const TRIP = "3B FULL_T04"

const reminder: fc.Arbitrary<Reminder> = fc.record({
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
  arrival:   fc.integer({ min: NOW, max: NOW + 9000 })
})

const wake: fc.Arbitrary<Wake> = fc.record({
  reminder: fc.constant("r1"),
  kind:     fc.constantFrom(...KINDS),
  seen:     fc.record({ time: fc.integer({ min: NOW - 600, max: NOW + 7200 }), band: fc.integer({ min: 30, max: 900 }), isLive: fc.boolean(), status: fc.constantFrom("coming" as const, "cancelled" as const, "passed" as const) }),
  at:       fc.constant(NOW)
})

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

test("the Worker is asked to watch the run, by its trip and scheduled time at the stop, that far ahead, and nothing more", () => {
  fc.assert(fc.property(reminder, reminder => {
    expect(watchOf(reminder)).toEqual({ stop: reminder.stop, route: reminder.route, trip: reminder.trip, scheduled: reminder.scheduled, lead: reminder.lead })
    expect(JSON.stringify(watchOf(reminder))).not.toContain(reminder.to)
  }))
})

test("a push means leaving for the bus where it's foretold, with how early to be there, or that it's missing once it's cancelled, past, or was gone before it was near", () => {
  fc.assert(fc.property(wake, wake => {
    const meaning = meaningOf(wake)
    if (wake.kind === "over" || wake.seen.status !== "coming")
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
    expect(body).toContain(reminder.to)
    expect(pushOf(wake)).not.toContain(reminder.to)
    const meaning = meaningOf(wake)
    if (meaning.kind === "missing")
      return
    const leave = leaveAt(reminder, meaning.eta, meaning.band)
    expect(meaning.eta - leave).toBe(reminder.walk + meaning.band)
    if (meaning.kind === "leave")
      expect(title).toBe(leave - NOW < 60 ? "Leave now" : `Leave in ${Math.max(1, Math.round((leave - NOW) / 60))} min`)
  }))
  const kept: Reminder = { id: "r1", trip: TRIP, route: "3", stop: "101", routeName: "3", stopName: "Kingsbury Hall", scheduled: NOW + 540, expected: NOW + 600, walk: 240, lead: 600, to: "MUB", arrival: NOW + 1200 }
  expect(textOf({ reminder: "r1", kind: "update", seen: { time: NOW + 900, band: 120, isLive: true, status: "coming" }, at: NOW }, kept, NOW)).toEqual({
    title: "Bus 3 is now due at 10:28 AM",
    // 15 minutes out, less the 4-minute walk and 2 minutes of band
    body:  "Leave in 9 min. Bus 3 reaches Kingsbury Hall at 10:28 AM (5 min late), 4 min walk. You'll be at MUB around 10:38 AM."
  })
  expect(textOf({ reminder: "r1", kind: "due", seen: { time: NOW + 600, band: 60, isLive: false, status: "cancelled" }, at: NOW }, kept, NOW)).toEqual({
    title: "Bus 3 may not be coming",
    body:  "notunh doesn't see the 10:23 AM at Kingsbury Hall. Open notunh for another way to MUB."
  })
})
