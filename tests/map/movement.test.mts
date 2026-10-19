import { test, expect } from "vitest"
import fc from "fast-check"
import { type Coordinates, ruler } from "../../src/geo/projection.mts"
import { toRouteLine } from "../../src/map/shapes.mts"
import { emptyModel } from "../../src/map/model.mts"
import type { Location } from "../../src/map/locate.mts"
import { NO_PACE, type Waypoint, type Whereabouts, course, courseAlong, drifted, paced } from "../../src/map/movement.mts"

const NOW = 1_791_900_000

const wayOf = (meters: number[], holds: (number | undefined)[] = []) =>
  meters.map((m, i): Waypoint => ({ stop: `${i}`, route: "R", isFirst: false, meters: i ? m : 0, ...holds[i] !== undefined && { hold: holds[i] } }))

const whereabouts = fc.oneof(
  fc.record({ elapsed: fc.integer({ min: 0, max: 600 }) }).map(({ elapsed }): Whereabouts => ({ arrive: NOW - elapsed })),
  fc.record({
    left:     fc.integer({ min: 0, max: 600 }),
    progress: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
    speed:    fc.option(fc.double({ min: 0, max: 20, noNaN: true }), { nil: undefined }),
    isHalted: fc.boolean()
  }).map(({ left, ...rest }): Whereabouts => ({ arrive: NOW - left - 30, depart: NOW - left, ...rest }))
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

test("along its course, a bus leaves each stop after it gets there and after leaving the one before, later the slower it's been driving, ever less sure", () =>
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 100, max: 3000 }), { minLength: 2, maxLength: 8 }),
    fc.double({ min: -0.5, max: 0.5, noNaN: true }),
    whereabouts,
    (meters, bias, where) => {
      const way = wayOf(meters)
      const usual = course(emptyModel(), way, where, NO_PACE, NOW)
      const slower = course(emptyModel(), way, where, { mean: bias, variance: 0, at: NOW }, NOW)
      usual.times.slice(1).forEach((time, i) => {
        expect(time).toBeGreaterThan(usual.times[i])
        expect(usual.arrivals[i + 1]).toBeLessThanOrEqual(time)
        expect(usual.variances[i + 1]).toBeGreaterThanOrEqual(usual.variances[i])
        // Further on, the bus's pace has had longer to wear off, but never turns around
        expect((slower.times[i + 1] - time) * bias).toBeGreaterThanOrEqual(-1e-6)
      })
      expect(usual.times[0]).toBeGreaterThanOrEqual(where.depart ?? NOW)
    }
  ))
)

test("where a bus is along its course never goes back, starts where it is, is at each stop while it's there, and ends at the last", () =>
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 100, max: 3000 }), { minLength: 2, maxLength: 8 }),
    whereabouts,
    fc.array(fc.double({ min: 0, max: 7200, noNaN: true }), { minLength: 2, maxLength: 20 }),
    (meters, where, offsets) => {
      const way = wayOf(meters)
      const { arrivals, times, distanceAt } = course(emptyModel(), way, where, NO_PACE, NOW)
      const marks = way.map((_, i) => way.slice(1, i + 1).reduce((sum, { meters }) => sum + meters, 0))
      const at = offsets.map(offset => NOW + offset).sort((a, b) => a - b)
      at.slice(1).forEach((time, i) => expect(distanceAt(time)).toBeGreaterThanOrEqual(distanceAt(at[i]) - 1e-6))
      expect(distanceAt(NOW)).toBeCloseTo(where.depart === undefined ? 0 : Math.max(0, Math.min(1, where.progress ?? distanceAt(NOW) / way[1].meters)) * way[1].meters, 6)
      for (let i = 1; i < way.length; i++) {
        expect(distanceAt(arrivals[i])).toBeCloseTo(marks[i], 3)
        expect(distanceAt((arrivals[i] + times[i]) / 2)).toBeCloseTo(marks[i], 3)
      }
      expect(distanceAt(times.at(-1)! + 1000)).toBeCloseTo(marks.at(-1)!, 6)
    }
  ))
)

test("a bus waits at a stop its trip waits at until its scheduled time, and goes on after", () =>
  fc.assert(fc.property(fc.array(fc.integer({ min: 100, max: 3000 }), { minLength: 3, maxLength: 6 }), fc.integer({ min: 0, max: 3600 }), (meters, late) => {
    const hold = NOW + late
    const { times, distanceAt } = course(emptyModel(), wayOf(meters, [undefined, hold]), { arrive: NOW - 60, depart: NOW - 30 }, NO_PACE, NOW)
    expect(times[1]).toBeGreaterThanOrEqual(hold)
    expect(distanceAt(hold - 1e-3)).toBeLessThanOrEqual(meters[1] + 1e-6)
  }))
)

test("a bus going faster now is further along a few seconds on than the same bus going slower", () =>
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 100, max: 3000 }), { minLength: 2, maxLength: 4 }),
    fc.double({ min: 0, max: 0.9, noNaN: true }),
    fc.double({ min: 0, max: 20, noNaN: true }),
    fc.double({ min: 0, max: 20, noNaN: true }),
    fc.double({ min: 0.5, max: 10, noNaN: true }),
    (meters, progress, a, b, seconds) => {
      const at = (speed: number) => course(emptyModel(), wayOf(meters), { arrive: NOW - 60, depart: NOW - 30, progress, speed }, NO_PACE, NOW).distanceAt(NOW + seconds)
      expect((at(a) - at(b)) * (a - b)).toBeGreaterThanOrEqual(-1e-6)
    }
  ))
)

test("a bus's course along its line starts where the location model has it", () =>
  fc.assert(fc.property(fc.integer({ min: 1, max: 5 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.boolean(), (stop, share, isThere) => {
    const east = ruler(43.135).kx
    const street = Array.from({ length: 201 }, (_, i): Coordinates => [-70.93 + i * 10 / east, 43.135])
    const line = toRouteLine("R", street, [Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, lat: 43.135, lon: -70.93 + (100 + i * 250) / east }))])
    const from = line.stops[stop].distance
    const distance = isThere ? from : from + share * 250
    const location: Location = {
      line, distance, sd: 5, speed: isThere ? 0 : 8, mode: isThere ? "dwelling" : "moving", since: NOW - 20, at: NOW,
      last: { stop: `s${stop}`, index: stop, distance: from, arrive: NOW - 40, ...!isThere && { depart: NOW - 20 } }
    }
    const along = courseAlong(emptyModel(), location, NO_PACE)!
    expect(along.from + along.course.distanceAt(NOW)).toBeCloseTo(distance, 3)
  }))
)
