import { test, expect } from "vitest"
import fc from "fast-check"
import { snapToLines } from "../../src/geo/follow.mts"
import { toLine } from "../../src/geo/lines.mts"
import type { Coordinates } from "../../src/geo/projection.mts"

const CENTER = { lat: 43.135, lon: -70.93 }

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

test("nothing snaps from further than 60 m off every line", () =>
  fc.assert(fc.property(fc.integer({ min: 61, max: 500 }), fc.boolean(), (meters, isNorth) => {
    const line = toLine(Array.from({ length: 11 }, (_, i): Coordinates => [CENTER.lon + i * 1e-3, CENTER.lat]))
    const lat = CENTER.lat + (isNorth ? meters : -meters) / 111_100
    expect(snapToLines([line], { lon: CENTER.lon + 5e-3, lat })).toBeUndefined()
  }))
)
