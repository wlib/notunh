import { test, expect } from "vitest"
import fc from "fast-check"
import { nearestOnLine, pointAt, positionsAlong, simplify, sliceLine, toLine } from "../../src/geo/lines.mts"
import { type Coordinates, ruler, segmentMeters } from "../../src/geo/projection.mts"

const CENTER = { lat: 43.135, lon: -70.93 }
const { kx: EAST, ky: NORTH } = ruler(CENTER.lat)

/** A point some meters east and north of the center */
const at = (east: number, north: number): Coordinates =>
  [CENTER.lon + east / EAST, CENTER.lat + north / NORTH]

// A closed loop, like most campus connectors: ~1 km radius, ~30 m between vertices, ending where it starts
const loop = (vertices: number): Coordinates[] =>
  Array.from({ length: vertices + 1 }, (_, i) => {
    const angle = 2 * Math.PI * i / vertices
    return [CENTER.lon + 0.0123 * Math.cos(angle), CENTER.lat + 0.009 * Math.sin(angle)]
  })

// Stops on the loop's vertices, in order and spaced a few hundred meters apart
const stopsOnLoop = fc
  .array(fc.integer({ min: 8, max: 40 }), { minLength: 1, maxLength: 12 })
  .map(gaps => {
    const indices = [0]
    for (const gap of gaps)
      if (indices.at(-1)! + gap <= 200)
        indices.push(indices.at(-1)! + gap)
    return indices
  })

test("stops on a loop are placed at their own vertices, in order, even where the loop returns to its start", () =>
  fc.assert(fc.property(stopsOnLoop, fc.boolean(), (indices, endsAtStart) => {
    const line = toLine(loop(200))
    const expected = endsAtStart ? [...indices, 200] : indices
    const stops = expected.map(i => ({ lon: line.coordinates[i][0], lat: line.coordinates[i][1] }))
    positionsAlong(line, stops).forEach((distance, i) => expect(distance).toBeCloseTo(line.distances[expected[i]], 4))
  }))
)

test("stops between far-apart vertices find their place along a street, and on the way back along another", () =>
  fc.assert(fc.property(
    fc.array(fc.double({ min: 0.05, max: 0.95, noNaN: true }), { minLength: 1, maxLength: 6 }),
    fc.array(fc.double({ min: 0.05, max: 0.95, noNaN: true }), { minLength: 1, maxLength: 6 }),
    (out, back) => {
      // A kilometer out along one street and back along another 150 m over, with vertices only at the ends
      const line = toLine([at(0, 0), at(0, 1000), at(150, 1000), at(150, 0)])
      const ahead = [...out].sort((a, b) => a - b)
      const behind = [...back].sort((a, b) => a - b)
      const stops = [
        ...ahead.map(t => at(0, t * 1000)),
        ...behind.map(t => at(150, (1 - t) * 1000))
      ].map(([lon, lat]) => ({ lon, lat }))
      const expected = [...ahead.map(t => t * 1000), ...behind.map(t => line.distances[2] + t * 1000)]
      positionsAlong(line, stops).forEach((distance, i) => expect(distance).toBeCloseTo(expected[i], 0))
    }
  ))
)

test("positions along a line never go backward, and stay on the line", () =>
  fc.assert(fc.property(
    fc.array(fc.tuple(fc.integer({ min: -2000, max: 2000 }), fc.integer({ min: -2000, max: 2000 })), { minLength: 2, maxLength: 60 }),
    fc.array(fc.tuple(fc.integer({ min: -2000, max: 2000 }), fc.integer({ min: -2000, max: 2000 })), { maxLength: 20 }),
    (points, stops) => {
      const line = toLine(points.map(([e, n]) => at(e, n)))
      const positions = positionsAlong(line, stops.map(([e, n]) => ({ lon: at(e, n)[0], lat: at(e, n)[1] })))
      for (let i = 1; i < positions.length; i++)
        expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1])
      for (const position of positions) {
        expect(position).toBeGreaterThanOrEqual(0)
        expect(position).toBeLessThanOrEqual(line.length)
      }
    }
  ))
)

// A straight line east, 10 m between vertices
const street = Array.from({ length: 201 }, (_, i) => at(i * 10, 0))

test("a distance along a line is that far along it, up to its end", () =>
  fc.assert(fc.property(fc.integer({ min: 0, max: 199 }), fc.integer({ min: 0, max: 400 }), (vertex, driven) => {
    const line = toLine(street)
    const { point, bearing } = pointAt(line, line.distances[vertex] + driven)
    expect(segmentMeters(street[vertex], point)).toBeCloseTo(Math.min(driven, (200 - vertex) * 10), 0)
    expect(bearing).toBeCloseTo(90, 0)
  }))
)

test("driving around a loop wraps back to its start", () => {
  const line = toLine(loop(200))
  expect(line.isLoop).toBe(true)
  expect(segmentMeters(pointAt(line, line.length + 50).point, pointAt(line, 50).point)).toBeLessThan(1)
})

// A wandering line of a few hundred meters, with bends a meter or two apart up to tens of meters
const wander = fc
  .array(fc.tuple(fc.integer({ min: -40, max: 40 }), fc.integer({ min: -40, max: 40 })), { minLength: 2, maxLength: 30 })
  .map(steps => steps.reduce<Coordinates[]>((line, [x, y]) => {
    const [lon, lat] = line.at(-1)!
    return [...line, [lon + x * 1.4e-5, lat + y * 1e-5]]
  }, [[CENTER.lon, CENTER.lat]]))

test("a simplified line keeps its ends and some of its bends, and strays no further from any than asked", () =>
  fc.assert(fc.property(wander, fc.double({ min: 0, max: 20, noNaN: true }), (coordinates, meters) => {
    const simpler = simplify(coordinates, meters)
    expect(simpler[0]).toEqual(coordinates[0])
    expect(simpler.at(-1)).toEqual(coordinates.at(-1))
    let i = 0
    for (const point of simpler)
      while (coordinates[i] !== point)
        expect(++i).toBeLessThan(coordinates.length)
    const line = toLine(simpler)
    for (const point of coordinates)
      expect(nearestOnLine(line, { lon: point[0], lat: point[1] }).meters).toBeLessThanOrEqual(meters + 0.01)
  }))
)

test("a slice of a line is as long as the distance between its ends, and slices either side of a point make the whole", () =>
  fc.assert(fc.property(wander, fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (coordinates, a, b) => {
    const line = toLine(coordinates)
    const [from, to] = [a * line.length, b * line.length]
    expect(toLine(sliceLine(line, from, to)).length).toBeCloseTo(Math.abs(to - from), 3)
    expect(sliceLine(line, to, from)).toEqual(sliceLine(line, from, to).reverse())
    const whole = [...sliceLine(line, 0, from), ...sliceLine(line, from, line.length).slice(1)]
    expect(toLine(whole).length).toBeCloseTo(line.length, 3)
  }))
)
