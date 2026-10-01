import { test, expect } from "vitest"
import fc from "fast-check"
import { toLine, type Coordinates, type Track } from "../../src/map/geometry.mts"
import { ZONE, createPace, expectedDistance, observe, type Trace } from "../../src/map/pace.mts"

const CENTER = { lat: 43.135, lon: -70.93 }

// A straight street east, 2 km long with a vertex every 10 m
const street = Array.from({ length: 201 }, (_, i): Coordinates => [CENTER.lon + i * 10 / 81_150, CENTER.lat])
const pointOn = (meters: number) => ({ lon: CENTER.lon + meters / 81_150, lat: CENTER.lat })

// Stops at least a few zones apart, about this many meters along the street
const stopPositions = fc
  .uniqueArray(fc.integer({ min: 2, max: 19 }), { minLength: 2, maxLength: 6 })
  .map(slots => slots.sort((a, b) => a - b).map(slot => slot * 100))

const lineWith = (positions: number[]) =>
  toLine(street, [positions.map((meters, i) => ({ id: `s${i}`, ...pointOn(meters) }))])

/**
 * Drives a bus down the street at a steady speed, stopping at each stop for its wait,
 * reporting every few seconds, and lets the pace learn from every report
 */
const run = (slots: number[], speed: number, waits: number[], every: number) => {
  const line = lineWith(slots)
  const pace = createPace()
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
  return { line, pace, positions }
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
        const drive = pace.drives.get(`s${i}>s${i + 1}`)
        expect(drive).toBeCloseTo((stop - positions[i] - 2 * ZONE) / speed, 3)
      })
      positions.forEach((_, i) =>
        expect(pace.zones.get(`s${i}`)).toBeCloseTo(2 * ZONE / speed + waits[i], 3)
      )
    }
  ))
)

test("a bus that left a stop is expected where the last bus was that long after leaving it", () =>
  fc.assert(fc.property(
    stopPositions,
    fc.integer({ min: 3, max: 12 }),
    fc.array(fc.integer({ min: 0, max: 60 }), { minLength: 6, maxLength: 6 }),
    fc.double({ min: 0, max: 1, noNaN: true }),
    (slots, speed, waits, share) => {
      const { line, pace, positions } = run(slots, speed, waits, ZONE / speed / 2)
      // A new bus just leaving the first stop's zone
      const start = positions[0] + ZONE
      const trace: Trace = { track: { line, distance: start }, at: 0, isStopped: false, left: { stop: 0, at: 0 } }
      const reach = (positions[1] - start) / speed

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
