import { test, expect } from "vitest"
import fc from "fast-check"
import { EXTRACTOR, INCOMPLETE, extract } from "../../src/map/events.mts"
import { BASE, drive, feedOf, scenario } from "./driving.mts"

/** The longest interval between the bus's fixes */
const longest = (every: number[]) =>
  Math.max(...every) + 1

test("a bus's fixes show each stop it went through, in order, timed to within its reports, and read by this extractor", () =>
  fc.assert(fc.property(scenario, plan => {
    const feed = feedOf(plan.vertices)
    const { fixes, stays } = drive(feed, plan)
    const visits = extract(feed, fixes)
    const bound = longest(plan.every)

    visits.slice(1).forEach((visit, i) => expect(visit.arrive).toBeGreaterThanOrEqual(visits[i].depart - 1))
    for (const visit of visits) {
      expect(visit.depart).toBeGreaterThanOrEqual(visit.arrive)
      expect(visit.extractor).toBe(EXTRACTOR)
      // Each one is a stop the bus really went through, then
      const stay = stays.find(stay => `s${stay.stop}` === visit.stop && Math.abs(stay.arrive - visit.arrive) <= bound)
      expect(stay).toBeDefined()
      if (!((visit.flags ?? 0) & INCOMPLETE))
        expect(Math.abs(stay!.depart - visit.depart)).toBeLessThanOrEqual(bound)
      // With how sure each time is
      const [arriveLow, arriveHigh, departLow, departHigh] = visit.spread!
      expect(arriveLow).toBeLessThanOrEqual(visit.arrive)
      expect(visit.arrive).toBeLessThanOrEqual(arriveHigh)
      expect(departLow).toBeLessThanOrEqual(visit.depart)
      expect(visit.depart).toBeLessThanOrEqual(departHigh)
    }
    // Every stop but the very first is seen, as the bus is only tracked from the first report
    expect(visits.length).toBeGreaterThanOrEqual(stays.length - 1)
  }))
)

test("visits follow their trip's stops in order, with the drive from the stop before and how its time was spent along the way", () =>
  fc.assert(fc.property(scenario, plan => {
    const feed = feedOf(plan.vertices)
    const visits = extract(feed, drive(feed, plan).fixes)
    for (const trip of ["T0", "T1"]) {
      const on = visits.filter(visit => visit.trip === trip)
      expect(on.length).toBeGreaterThan(0)
      on.slice(1).forEach((visit, i) => {
        expect(visit.position).toBeGreaterThan(on[i].position!)
        if (visit.position === on[i].position! + 1) {
          expect(visit.from).toBe(on[i].stop)
          expect(visit.left).toBeCloseTo(on[i].depart, 6)
          expect(visit.meters).toBeGreaterThan(0)
          visit.profile?.forEach((share, j) => {
            expect(share).toBeGreaterThanOrEqual(j ? visit.profile![j - 1] : 0)
            expect(share).toBeLessThanOrEqual(1)
          })
        }
      })
      for (const visit of on)
        expect(visit.scheduled).toBe(BASE + feed.trips.find(({ id }) => id === trip)!.times[visit.position!])
    }
  }))
)

test("the layover between two trips of one bus is from getting in at the end of one to leaving on the next", () =>
  fc.assert(fc.property(scenario, plan => {
    const feed = feedOf(plan.vertices)
    const { fixes, stays } = drive(feed, plan)
    const layovers = extract(feed, fixes).filter(visit => visit.gotIn !== undefined)
    const stay = stays.find(stay => stay.stop === 0 && stay.lap === 1)!
    expect(layovers).toHaveLength(1)
    expect(layovers[0]).toMatchObject({ trip: "T1", position: 0, stop: "s0" })
    expect(Math.abs(layovers[0].gotIn! - stay.arrive)).toBeLessThanOrEqual(longest(plan.every))
    expect(Math.abs(layovers[0].depart - stay.depart)).toBeLessThanOrEqual(longest(plan.every))
  }))
)

test("nothing is made up across a gap in a bus's reports", () =>
  fc.assert(fc.property(scenario, fc.integer({ min: 0, max: 1000 }), (plan, skip) => {
    const feed = feedOf(plan.vertices)
    const { fixes } = drive(feed, plan)
    const sorted = [...new Map(fixes.map(fix => [fix.at, fix])).values()].sort((a, b) => a.at - b.at)
    // Forty minutes without a report, from somewhere along the way
    const from = sorted[skip % sorted.length].at
    const gapped = sorted.filter(fix => fix.at < from || fix.at >= from + 2_400_000)
    for (const visit of extract(feed, gapped)) {
      expect(visit.arrive * 1000 < from || visit.arrive * 1000 >= from + 2_400_000).toBe(true)
      if (visit.gotIn !== undefined)
        expect(visit.gotIn * 1000 < from || visit.gotIn * 1000 >= from + 2_400_000).toBe(true)
    }
  }))
)
