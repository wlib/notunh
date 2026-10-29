import { test, expect } from "vitest"
import fc from "fast-check"
import type { Observation } from "../../src/transit/inference/likelihoods.mts"
import { match } from "../../src/transit/inference/matching.mts"
import { GENERIC, drive as kinematics } from "../../src/transit/inference/passages.mts"
import { locator, passagesOf } from "../../src/transit/inference/locate.mts"
import { type Coordinates, ruler } from "../../src/geo/projection.mts"
import { toRouteLine } from "../../src/transit/shapes.mts"
import { feedOf, drive, scenario, type Stay } from "./driving.mts"

const CENTER = { lat: 43.135, lon: -70.93 }

/** A bus's fixes in order, each once, as the location model takes them */
const observed = (fixes: ReturnType<typeof drive>["fixes"]): Observation[] =>
  [...new Map(fixes.map(fix => [fix.at, fix])).values()]
    .sort((a, b) => a.at - b.at)
    .map(fix => ({ at: fix.at / 1000, lat: fix.lat, lon: fix.lon, heading: fix.heading, kph: fix.kph }))

/** The longest stretch between the fixes either side of a moment */
const bracket = (fixes: readonly Observation[], at: number) => {
  const after = fixes.findIndex(fix => fix.at >= at)
  return after <= 0 ? Infinity : fixes[after].at - fixes[after - 1].at
}

/** The stay a passage is of, by stop and lap, the nearest in time */
const stayOf = (stays: readonly Stay[], stop: string, at: number) =>
  stays.filter(stay => `s${stay.stop}` === stop).sort((a, b) => Math.abs(a.arrive - at) - Math.abs(b.arrive - at))[0]

test("driving a stretch takes longer the slower it cruises, and gets each way along it in order, all of it in its time", () =>
  fc.assert(fc.property(
    fc.double({ min: 1, max: 3000, noNaN: true }),
    fc.double({ min: 0, max: 20, noNaN: true }),
    fc.double({ min: 0, max: 20, noNaN: true }),
    fc.double({ min: 1, max: 30, noNaN: true }),
    fc.double({ min: 0, max: 1, noNaN: true }),
    (meters, from, to, cruise, share) => {
      const piece = kinematics(meters, from, to, cruise)
      expect(piece.time).toBeGreaterThan(0)
      expect(piece.timeTo(meters) / piece.time).toBeCloseTo(1, 6)
      expect(piece.timeTo(0)).toBeCloseTo(0, 9)
      expect(piece.timeTo(share * meters)).toBeLessThanOrEqual(piece.timeTo(meters) + 1e-9)
      expect(kinematics(meters, from, to, cruise * 1.5).time).toBeLessThanOrEqual(piece.time + 1e-9)
    }
  ))
)

test("a bus's fixes show each stop it went through, in order, each time within the fixes either side of it, and as sure as they are, or when first or last seen there", () =>
  fc.assert(fc.property(scenario, plan => {
    const feed = feedOf(plan.vertices)
    const { fixes, stays, line } = drive(feed, plan)
    const seen = observed(fixes)
    const passages = passagesOf([line], seen).flat()
    // Every stop but the very first, unless the bus was still there at its first fix
    expect(passages.length).toBeGreaterThanOrEqual(stays.length - 1)
    expect(passages[0].isJoined).toBe(passages[0].arrive.median === seen[0].at)
    passages.slice(1).forEach((passage, i) => {
      expect(passage.index).toBeGreaterThan(passages[i].index)
      expect(passage.arrive.median).toBeGreaterThanOrEqual(passages[i].depart.median - 1)
    })
    for (const passage of passages) {
      for (const { low, median, high } of [passage.arrive, passage.depart]) {
        expect(low).toBeLessThanOrEqual(median)
        expect(median).toBeLessThanOrEqual(high)
      }
      expect(passage.depart.median).toBeGreaterThanOrEqual(passage.arrive.median)
      const stay = stayOf(stays, passage.stop, passage.arrive.median)
      if (passage.isJoined)
        expect(stay.arrive).toBeLessThanOrEqual(passage.arrive.median)
      else
        expect(Math.abs(passage.arrive.median - stay.arrive)).toBeLessThanOrEqual(bracket(seen, stay.arrive) + 2)
      if (!passage.isIncomplete)
        expect(Math.abs(passage.depart.median - stay.depart)).toBeLessThanOrEqual(bracket(seen, stay.depart) + 2)
    }
  }))
)

test("a bus that waited at a stop through several fixes stopped there, and one that sped through between two fixes close together didn't", () =>
  fc.assert(fc.property(scenario, plan => {
    const feed = feedOf(plan.vertices)
    const { fixes, stays, line } = drive(feed, plan)
    const seen = observed(fixes)
    for (const passage of passagesOf([line], seen).flat()) {
      const stay = stayOf(stays, passage.stop, passage.arrive.median)
      if (stay.depart - stay.arrive > 2 * Math.max(...plan.every))
        expect(passage.dwelled).toBeGreaterThan(0.5)
      // At full speed either side of it, with no time spare
      if (stay.depart === stay.arrive && bracket(seen, stay.arrive) <= 12 && plan.cruise >= 8 && passage.distance - passage.line.stops[0].distance > 300)
        expect(passage.dwelled).toBeLessThan(0.5)
    }
  }))
)

test("the same fixes always give the same passages, and the live locator finds the same stops as matching the whole day, at about the same times", () =>
  fc.assert(fc.property(scenario, plan => {
    const feed = feedOf(plan.vertices)
    const { fixes, line } = drive(feed, plan)
    const seen = observed(fixes)
    const offline = passagesOf([line], seen).flat()
    expect(passagesOf([line], seen).flat()).toEqual(offline)
    const live = locator([line])
    const online = [...seen.flatMap(fix => live.observe(fix)), ...live.finish()]
    expect(online.map(passage => passage.index)).toEqual(offline.map(passage => passage.index))
    // Where matching it all at once puts a fix a few meters elsewhere, as near the end of a loop, a time moves a little
    online.forEach((passage, i) => expect(Math.abs(passage.arrive.median - offline[i].arrive.median)).toBeLessThanOrEqual(Math.max(...plan.every)))
    // Each run drives a whole route and matches it twice over
  }), { numRuns: 50 })
)

test("nothing is made up across a long silence, which starts a new track", () =>
  fc.assert(fc.property(scenario, fc.integer({ min: 0, max: 1000 }), (plan, skip) => {
    const feed = feedOf(plan.vertices)
    const { fixes, line } = drive(feed, plan)
    const seen = observed(fixes)
    // Forty minutes without a fix, from somewhere along the way
    const from = seen[skip % seen.length].at
    const gapped = seen.filter(fix => fix.at < from || fix.at >= from + 2400)
    for (const passage of passagesOf([line], gapped).flat())
      expect(passage.arrive.median < from || passage.arrive.median >= from + 2400).toBe(true)
  }))
)

test("a fix is matched to the pass along a street it's heading along, where a line goes out along it and back", () =>
  fc.assert(fc.property(fc.integer({ min: 5, max: 95 }), fc.boolean(), (at, isBack) => {
    // A street east, out a kilometer and back along it
    const east = ruler(CENTER.lat).kx
    const out = Array.from({ length: 101 }, (_, i): Coordinates => [CENTER.lon + i * 10 / east, CENTER.lat])
    const line = toRouteLine("R", [...out, ...out.toReversed().slice(1)], [])
    const fix: Observation = { at: 0, lat: CENTER.lat, lon: CENTER.lon + at * 10 / east, heading: isBack ? 270 : 90, kph: 30 }
    const [[{ distance }]] = match([line], [fix])
    expect(distance).toBeCloseTo(isBack ? 2000 - at * 10 : at * 10, 0)
  }))
)

test("a stop gone through quicker than a bus is thought to drive is timed anywhere between the fixes either side of it, not exactly", () => {
  const east = ruler(CENTER.lat).kx
  const at = (meters: number, seconds: number): Observation => ({ at: seconds, lat: CENTER.lat, lon: CENTER.lon + meters / east, heading: 90, kph: 36 })
  const street = Array.from({ length: 101 }, (_, i): Coordinates => [CENTER.lon + i * 10 / east, CENTER.lat])
  const line = toRouteLine("R", street, [[200, 600].map((meters, i) => ({ id: `s${i}`, lat: CENTER.lat, lon: CENTER.lon + meters / east }))])
  const [[passage]] = passagesOf([line], [at(100, 0), at(400, 10)], { ...GENERIC, cruise: () => 0.1 })
  expect(passage.stop).toBe("s0")
  for (const time of [passage.arrive, passage.depart])
    expect(time).toEqual({ low: 0, median: expect.closeTo(10 / 3, 6), high: 10 })
})
