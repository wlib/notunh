import { test, expect } from "vitest"
import fc from "fast-check"
import { coveredPadding, indicesAlongShape, pointAt, snapToLines, toLine, type Coordinates } from "../../src/map/geometry.mts"

const CENTER = { lat: 43.135, lon: -70.93 }

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

test("stops on a loop map to their own vertices, in order, even where the loop returns to its start", () =>
  fc.assert(fc.property(stopsOnLoop, fc.boolean(), (indices, endsAtStart) => {
    const shape = loop(200)
    const expected = endsAtStart ? [...indices, 200] : indices
    const stops = expected.map(i => ({ lon: shape[i][0], lat: shape[i][1] }))
    indicesAlongShape(shape, stops).forEach((index, i) => expect(index).toBeCloseTo(expected[i], 6))
  }))
)

test("stops between far-apart vertices find their place along a street, and on the way back along another", () =>
  fc.assert(fc.property(
    fc.array(fc.double({ min: 0.05, max: 0.95, noNaN: true }), { minLength: 1, maxLength: 6 }),
    fc.array(fc.double({ min: 0.05, max: 0.95, noNaN: true }), { minLength: 1, maxLength: 6 }),
    (out, back) => {
      // A kilometer out along one street and back along another 150 m over, with vertices only at the ends
      const [x, y] = [1 / 81_150, 1 / 110_540]
      const shape: Coordinates[] = [[0, 0], [0, 1000], [150, 1000], [150, 0]].map(([e, n]) => [CENTER.lon + e * x, CENTER.lat + n * y])
      const ahead = [...out].sort((a, b) => a - b)
      const behind = [...back].sort((a, b) => a - b)
      const stops = [
        ...ahead.map(t => ({ lon: CENTER.lon, lat: CENTER.lat + t * 1000 * y })),
        ...behind.map(t => ({ lon: CENTER.lon + 150 * x, lat: CENTER.lat + (1 - t) * 1000 * y }))
      ]
      const expected = [...ahead, ...behind.map(t => 2 + t)]
      indicesAlongShape(shape, stops).forEach((index, i) => expect(index).toBeCloseTo(expected[i], 3))
    }
  ))
)

test("indices along a shape never go backward", () =>
  fc.assert(fc.property(
    fc.array(fc.tuple(fc.integer({ min: -2000, max: 2000 }), fc.integer({ min: -2000, max: 2000 })), { minLength: 1, maxLength: 60 }),
    fc.array(fc.tuple(fc.integer({ min: -2000, max: 2000 }), fc.integer({ min: -2000, max: 2000 })), { maxLength: 20 }),
    (points, stops) => {
      const shape = points.map(([x, y]): Coordinates => [CENTER.lon + x * 1e-5, CENTER.lat + y * 1e-5])
      const indices = indicesAlongShape(shape, stops.map(([x, y]) => ({ lon: CENTER.lon + x * 1e-5, lat: CENTER.lat + y * 1e-5 })))
      for (let i = 1; i < indices.length; i++)
        expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1])
      for (const index of indices)
        expect(index).toBeLessThanOrEqual(shape.length - 1)
    }
  ))
)

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height })

const viewport = fc.record({ width: fc.integer({ min: 300, max: 2000 }), height: fc.integer({ min: 400, max: 1400 }) })

test("a bottom sheet pads the bottom by what it covers", () =>
  fc.assert(fc.property(viewport, fc.double({ min: 0.1, max: 0.6, noNaN: true }), ({ width, height }, share) => {
    const padding = coveredPadding(rect(0, 0, width, height), rect(0, height * (1 - share), width, height * share), 48)
    expect(padding).toEqual({ top: 48, left: 48, right: 48, bottom: expect.closeTo(48 + height * share, 6) })
  }))
)

test("a side panel pads its side, and a panel off the map pads nothing extra", () =>
  fc.assert(fc.property(viewport, fc.integer({ min: 280, max: 420 }), fc.integer({ min: 0, max: 24 }), ({ width, height }, panelWidth, gap) => {
    fc.pre(panelWidth + gap < width / 2)
    const area = rect(0, 0, width, height)
    expect(coveredPadding(area, rect(gap, gap, panelWidth, height / 2), 48))
      .toEqual({ top: 48, bottom: 48, right: 48, left: expect.closeTo(48 + gap + panelWidth, 6) })
    expect(coveredPadding(area, rect(width, 0, panelWidth, height), 48))
      .toEqual({ top: 48, bottom: 48, left: 48, right: 48 })
  }))
)

const meters = ([lon, lat]: Coordinates, [lon2, lat2]: Coordinates) =>
  Math.hypot((lon2 - lon) * 111_320 * Math.cos(lat * Math.PI / 180), (lat2 - lat) * 110_540)

// A straight line east, 10 m between vertices
const street = Array.from({ length: 201 }, (_, i): Coordinates => [CENTER.lon + i * 10 / 81_150, CENTER.lat])

test("a bus snapped onto a line drives along it by the distance it covers", () =>
  fc.assert(fc.property(fc.integer({ min: 0, max: 199 }), fc.integer({ min: 0, max: 400 }), (vertex, driven) => {
    const line = toLine(street)
    const track = snapToLines([line], { lon: street[vertex][0], lat: street[vertex][1] }, 90)!
    const { point, bearing } = pointAt(line, track.distance + driven)

    expect(meters(street[vertex], point)).toBeCloseTo(Math.min(driven, (200 - vertex) * 10), 0)
    expect(bearing).toBeCloseTo(90, 0)
  }))
)

test("driving around a loop wraps back to its start", () => {
  const line = toLine(loop(200))
  expect(line.isLoop).toBe(true)
  expect(meters(pointAt(line, line.length + 50).point, pointAt(line, 50).point)).toBeLessThan(1)
})

test("a bus snaps to the side of the street it's heading along", () =>
  fc.assert(fc.property(fc.integer({ min: 1, max: 99 }), fc.boolean(), (vertex, isEastbound) => {
    const east = toLine(Array.from({ length: 101 }, (_, i): Coordinates => [CENTER.lon + i * 1e-4, CENTER.lat]))
    const west = toLine(east.coordinates.toReversed())
    const track = snapToLines([east, west], { lon: east.coordinates[vertex][0], lat: CENTER.lat }, isEastbound ? 90 : 270)!
    expect(track.line).toBe(isEastbound ? east : west)
  }))
)

test("a bus with no heading stays on the pass along a street it was on, on a line that drives it both ways", () =>
  fc.assert(fc.property(fc.integer({ min: 15, max: 85 }), fc.integer({ min: -2, max: 10 }), fc.boolean(), (vertex, moved, isOut) => {
    // Out along the street and most of the way back on the same road
    const out = Array.from({ length: 101 }, (_, i): Coordinates => [CENTER.lon + i * 1e-4, CENTER.lat])
    const line = toLine([...out, ...out.toReversed().slice(1, -3)])
    const index = isOut ? vertex : 200 - vertex
    const previous = { line, distance: line.distances[index] }
    const next = isOut ? vertex + moved : vertex - moved
    const track = snapToLines([line], { lon: out[next][0], lat: CENTER.lat }, undefined, previous)!
    expect(Math.abs(track.distance - previous.distance)).toBeLessThan(200)
  }))
)

