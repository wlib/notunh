import { test, expect } from "vitest"
import fc from "fast-check"
import type { Track } from "../../src/geo/follow.mts"
import { type Coordinates, ruler } from "../../src/geo/projection.mts"
import { toRouteLine } from "../../src/map/shapes.mts"
import { ZONE, type Trace } from "../../src/map/crossings.mts"
import { DEFAULT_RATE, NO_PACE, createLately, drifted, expectedDistance, observe, paced } from "../../src/map/pace.mts"

const CENTER = { lat: 43.135, lon: -70.93 }
const EAST = ruler(CENTER.lat).kx

// A straight street east, 2 km long with a vertex every 10 m
const street = Array.from({ length: 201 }, (_, i): Coordinates => [CENTER.lon + i * 10 / EAST, CENTER.lat])
const pointOn = (meters: number) => ({ lon: CENTER.lon + meters / EAST, lat: CENTER.lat })

// Stops at least a few zones apart, about this many meters along the street
const stopPositions = fc
  .uniqueArray(fc.integer({ min: 2, max: 19 }), { minLength: 2, maxLength: 6 })
  .map(slots => slots.sort((a, b) => a - b).map(slot => slot * 100))

const lineWith = (positions: number[]) =>
  toRouteLine("R", street, [positions.map((meters, i) => ({ id: `s${i}`, ...pointOn(meters) }))])

/**
 * Drives a bus down the street at a steady speed, stopping at each stop for its wait,
 * reporting every few seconds, and lets what's learned of buses lately learn from every report
 */
const run = (slots: number[], speed: number, waits: number[], every: number) => {
  const line = lineWith(slots)
  const pace = createLately()
  // Measured along the line itself
  const positions = line.stops.map(stop => stop.distance)

  // Where the bus is at a time: driving, or waiting at a stop's center
  const legs: { start: number, end: number, from: number, to: number }[] = []
  let [time, at] = [0, 0]
  positions.forEach((stop, i) => {
    legs.push({ start: time, end: time + (stop - at) / speed, from: at, to: stop })
    time += (stop - at) / speed
    legs.push({ start: time, end: time + waits[i], from: stop, to: stop })
    time += waits[i]
    at = stop
  })
  // And on past the last stop
  legs.push({ start: time, end: time + (line.length - at) / speed, from: at, to: line.length })
  time += (line.length - at) / speed
  const positionAt = (t: number) => {
    const leg = legs.find(leg => t <= leg.end) ?? legs.at(-1)!
    return leg.end === leg.start ? leg.to : leg.from + (leg.to - leg.from) * Math.min(1, (t - leg.start) / (leg.end - leg.start))
  }

  let trace: Trace | undefined
  for (let t = 0; t <= time; t += every)
    trace = observe(pace, trace, { line, distance: positionAt(t) } satisfies Track, t, false)
  return { line, pace, positions, trace: trace! }
}

test("a bus seen driving between stops teaches how long that stretch and each stop take", () =>
  fc.assert(fc.property(
    stopPositions,
    fc.integer({ min: 3, max: 12 }),
    fc.array(fc.integer({ min: 0, max: 60 }), { minLength: 6, maxLength: 6 }),
    (slots, speed, waits) => {
      // Reports come often enough that every zone edge is crossed between two reports at full speed
      const { pace, positions } = run(slots, speed, waits, ZONE / speed / 2)

      positions.slice(1).forEach((stop, i) => {
        const drive = pace.drives.get(`s${i}>s${i + 1}`)?.seconds
        expect(drive).toBeCloseTo((stop - positions[i] - 2 * ZONE) / speed, 3)
      })
      positions.forEach((_, i) =>
        expect(pace.zones.get(`s${i}`)?.seconds).toBeCloseTo(2 * ZONE / speed + waits[i], 3)
      )
    }
  ))
)

test("stops close enough that their zones overlap teach no drive between them, and nothing learned is ever negative", () =>
  fc.assert(fc.property(
    fc.integer({ min: 2, max: 18 }),
    fc.integer({ min: 1, max: 2 * ZONE - 1 }),
    fc.integer({ min: 3, max: 12 }),
    (slot, gap, speed) => {
      const { pace } = run([slot * 100, slot * 100 + gap], speed, [10, 10], ZONE / speed / 2)
      expect(pace.drives.has("s0>s1")).toBe(false)
      for (const { seconds } of [...pace.drives.values(), ...pace.zones.values()])
        expect(seconds).toBeGreaterThan(0)
    }
  ))
)

test("a bus that left a stop is expected where the last bus was that long after leaving it", () =>
  fc.assert(fc.property(
    // With a stop past the next, so it pulls out of that one at a pace learned too
    stopPositions.filter(slots => slots.length > 2),
    fc.integer({ min: 3, max: 12 }),
    fc.array(fc.integer({ min: 0, max: 60 }), { minLength: 6, maxLength: 6 }),
    fc.double({ min: 0, max: 1, noNaN: true }),
    (slots, speed, waits, share) => {
      const { line, pace, positions } = run(slots, speed, waits, ZONE / speed / 2)
      // A new bus just leaving the first stop's zone
      const start = positions[0] + ZONE
      const trace: Trace = { track: { line, distance: start }, at: 0, isStopped: false, left: { stop: 0, at: 0 } }
      const reach = (positions[1] - start) / speed
      // At a fixed learned pace, so what was learned is kept fresh through the whole prediction, or its decay after
      // the bus arrives would change the rate while it waits
      for (const seen of [...pace.drives.values(), ...pace.zones.values()])
        seen.at = reach + waits[1]

      expect(expectedDistance(pace, trace, share * reach)).toBeCloseTo(start + share * reach * speed, 2)
      // Then it waits at the next stop as long as the last bus did
      expect(expectedDistance(pace, trace, reach + waits[1] * share)).toBeCloseTo(positions[1], 2)
    }
  ))
)

test("a bus is never expected to go backward as time passes", () =>
  fc.assert(fc.property(
    stopPositions,
    fc.integer({ min: 3, max: 12 }),
    fc.array(fc.integer({ min: 0, max: 60 }), { minLength: 6, maxLength: 6 }),
    fc.integer({ min: 0, max: 2000 }),
    fc.boolean(),
    fc.double({ min: 0, max: 120, noNaN: true }),
    fc.double({ min: 0, max: 120, noNaN: true }),
    (slots, speed, waits, distance, isStopped, a, b) => {
      const { line, pace } = run(slots, speed, waits, 1)
      const trace: Trace = { track: { line, distance }, at: 0, isStopped }
      const [earlier, later] = [Math.min(a, b), Math.max(a, b)]
      expect(expectedDistance(pace, trace, later)).toBeGreaterThanOrEqual(expectedDistance(pace, trace, earlier) - 1e-9)
      expect(expectedDistance(pace, trace, later)).toBeLessThanOrEqual(line.length + 1e-9)
    }
  ))
)

test("a bus at a stop where its trip waits for its scheduled time is expected there until then", () =>
  fc.assert(fc.property(
    stopPositions.filter(slots => slots.length > 2),
    fc.integer({ min: 3, max: 12 }),
    fc.integer({ min: 10, max: 600 }),
    fc.double({ min: 0, max: 1, noNaN: true }),
    (slots, speed, hold, share) => {
      const { line, pace, positions } = run(slots, speed, [0, 0, 0, 0, 0, 0], ZONE / speed / 2)
      const trace: Trace = { track: { line, distance: positions[1] }, at: 0, isStopped: true, entered: { stop: 1, at: 0 }, holds: new Map([["s1", hold]]) }
      expect(expectedDistance(pace, trace, share * hold)).toBeLessThanOrEqual(positions[1] + ZONE + 1e-9)
      expect(expectedDistance(pace, { ...trace, holds: undefined }, hold + 60)).toBeGreaterThan(positions[1] + ZONE)
    }
  ))
)

test("how slow or quick a bus has lately been carries over, shrunk, to stretches nobody's driven", () =>
  fc.assert(fc.property(
    stopPositions.filter(slots => slots.length > 2),
    fc.integer({ min: 2, max: 12 }).filter(speed => speed !== DEFAULT_RATE),
    (slots, speed) => {
      const { line, pace, positions, trace: driven } = run(slots, speed, [0, 0, 0, 0, 0, 0], ZONE / speed / 2)
      // The first stretch, as if nobody had driven it, by the same bus just now
      pace.drives.delete("s0>s1")
      const start = positions[0] + ZONE
      const trace: Trace = { track: { line, distance: start }, at: 0, isStopped: false, left: { stop: 0, at: 0 }, pace: { ...driven.pace!, at: 0 } }
      const rate = (expectedDistance(pace, trace, 1) - start) / 1
      expect(Math.min(speed, DEFAULT_RATE)).toBeLessThan(rate + 1e-9)
      expect(rate).toBeLessThan(Math.max(speed, DEFAULT_RATE) + 1e-9)
      expect(rate).not.toBeCloseTo(DEFAULT_RATE, 3)
    }
  ))
)

test("GPS wandering a little way back leaves a bus where it got to", () =>
  fc.assert(fc.property(stopPositions, fc.integer({ min: 0, max: 1999 }), fc.double({ min: 0.1, max: 29, noNaN: true }), (slots, distance, back) => {
    const line = lineWith(slots)
    const pace = createLately()
    const previous = observe(pace, undefined, { line, distance }, 0, true)
    const next = observe(pace, previous, { line, distance: Math.max(0, distance - back) }, 10, true)
    expect(next.track.distance).toBe(distance)
    expect(next.at).toBe(10)
  }))
)

test("a bus's pace follows how much longer than expected its legs take, and drifts back to usual while it's unseen", () =>
  fc.assert(fc.property(fc.array(fc.double({ min: -0.5, max: 0.5, noNaN: true }), { minLength: 1, maxLength: 20 }), fc.double({ min: 0, max: 1e5, noNaN: true }), (excesses, later) => {
    let pace = NO_PACE
    excesses.forEach((excess, i) => {
      const next = paced(pace, excess, i * 60)
      // A step toward what it saw, and surer for it
      expect(Math.abs(next.mean - excess)).toBeLessThanOrEqual(Math.abs(drifted(pace, i * 60).mean - excess) + 1e-12)
      expect(next.variance).toBeLessThan(drifted(pace, i * 60).variance)
      pace = next
    })
    const unseen = drifted(pace, pace.at + later)
    expect(Math.abs(unseen.mean)).toBeLessThanOrEqual(Math.abs(pace.mean) + 1e-12)
    expect(unseen.variance).toBeLessThanOrEqual(NO_PACE.variance + 1e-12)
    expect(drifted(pace, pace.at + 1e7).mean).toBeCloseTo(0, 9)
  }))
)

test("a bus is seen at the stop it's in, else the last it went through, and starts afresh on another route", () =>
  fc.assert(fc.property(stopPositions, fc.integer({ min: 3, max: 12 }), (slots, speed) => {
    const { line, trace } = run(slots, speed, [5, 5, 5, 5, 5, 5], ZONE / speed / 2)
    // Driven past the last stop, it was last seen leaving it
    expect(trace.seen).toMatchObject({ stop: line.stops.at(-1)!.id })
    expect(trace.seen!.depart).toBeGreaterThan(trace.seen!.arrive)
    // Lost for a while, it's still where it was last seen until it's seen somewhere else
    expect(observe(createLately(), trace, { line, distance: line.stops[0].distance }, trace.at + 1000, true).seen).toEqual(trace.seen)
    const elsewhere = observe(createLately(), trace, { line: { ...line, route: "other" }, distance: line.stops[0].distance }, trace.at + 5, true)
    expect(elsewhere.seen).toBeUndefined()
    expect(elsewhere.pace).toBeUndefined()
  }))
)
