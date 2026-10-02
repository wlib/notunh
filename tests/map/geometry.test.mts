import { test, expect } from "vitest"
import fc from "fast-check"
import { coveredPadding, indicesAlongShape, offsetLine, pointAt, snapToLines, toLine, type Coordinates } from "../../src/map/geometry.mts"

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
    expect(indicesAlongShape(shape, stops)).toEqual(expected)
  }))
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
        expect(index).toBeLessThan(shape.length)
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

// A line wandering gently about town: steps of 10 to 50 m, turning up to 30° at a time
const gentleLines = fc
  .array(fc.tuple(fc.double({ min: 10, max: 50, noNaN: true }), fc.double({ min: -30, max: 30, noNaN: true })), { minLength: 1, maxLength: 20 })
  .map(steps => {
    let heading = 0
    return steps.reduce<Coordinates[]>((points, [meters, turn]) => {
      heading += turn
      const [lon, lat] = points.at(-1)!
      const radians = heading * Math.PI / 180
      return [...points, [lon + Math.sin(radians) * meters / 81_150, lat + Math.cos(radians) * meters / 110_540]]
    }, [[-70.93, 43.135]])
  })

test("an offset line with no offset is the line itself", () =>
  fc.assert(fc.property(gentleLines, line => {
    offsetLine(line, line.map(() => 0)).forEach((point, i) => {
      expect(point[0]).toBeCloseTo(line[i][0], 9)
      expect(point[1]).toBeCloseTo(line[i][1], 9)
    })
  }))
)

test("an offset line runs its offset away, to the right for positive and the left for negative", () =>
  fc.assert(fc.property(gentleLines, fc.double({ min: -8, max: 8, noNaN: true }), (line, meters) => {
    const offset = offsetLine(line, line.map(() => meters))
    // Right of the way the line starts out for positive offsets, by the sign of the cross product
    const direction = [(line[1][0] - line[0][0]) * 81_150, (line[1][1] - line[0][1]) * 110_540]
    const shift = [(offset[0][0] - line[0][0]) * 81_150, (offset[0][1] - line[0][1]) * 110_540]
    if (Math.abs(meters) > 0.01)
      expect(Math.sign(direction[0] * shift[1] - direction[1] * shift[0])).toBe(-Math.sign(meters))
    // Every point is about the offset from the line, a little more at mitered corners
    for (const point of offset) {
      const nearest = Math.min(...line.slice(1).map((b, i) => {
        const a = line[i]
        const [ax, ay, bx, by] = [(a[0] - point[0]) * 81_150, (a[1] - point[1]) * 110_540, (b[0] - point[0]) * 81_150, (b[1] - point[1]) * 110_540]
        const [dx, dy] = [bx - ax, by - ay]
        const t = Math.min(1, Math.max(0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
        return Math.hypot(ax + t * dx, ay + t * dy)
      }))
      expect(nearest).toBeGreaterThan(Math.abs(meters) * 0.95 - 0.05)
      expect(nearest).toBeLessThan(Math.abs(meters) * 2 + 0.05)
    }
  }))
)
