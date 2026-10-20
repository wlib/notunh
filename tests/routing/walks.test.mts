import { test, expect } from "vitest"
import fc from "fast-check"
import { nearestOnLine, pointAt, sliceLine, toLine } from "../../src/geo/lines.mts"
import { type Coordinates, ruler } from "../../src/geo/projection.mts"
import { type Progress, isOffPath, walkOn } from "../../src/routing/walks.mts"
import type { Fix } from "../../src/geo/fixes.mts"

const CENTER = { lat: 43.135, lon: -70.93 }
const { kx: EAST, ky: NORTH } = ruler(CENTER.lat)

/** A point some meters east and north of another */
const offset = ([lon, lat]: Coordinates, east: number, north: number): Coordinates =>
  [lon + east / EAST, lat + north / NORTH]

/** A walk of a few stretches, each turning by at most some degrees from the last */
const path = (maxTurn: number, minLength: number) =>
  fc
    .tuple(
      fc.double({ min: 0, max: 360, noNaN: true }),
      fc.array(
        fc.tuple(fc.double({ min: -maxTurn, max: maxTurn, noNaN: true }), fc.integer({ min: minLength, max: 150 })),
        { minLength: 1, maxLength: 8 }
      )
    )
    .map(([heading, stretches]) => {
      const coordinates: Coordinates[] = [[CENTER.lon, CENTER.lat]]
      for (const [turn, meters] of stretches) {
        heading += turn
        const radians = heading * Math.PI / 180
        coordinates.push(offset(coordinates.at(-1)!, meters * Math.sin(radians), meters * Math.cos(radians)))
      }
      return toLine(coordinates)
    })

/** Somewhere within a radius of a point, as GPS puts you */
const jitter = (radius: number) =>
  fc.tuple(fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }), fc.double({ min: 0, max: radius, noNaN: true }))

const fixAt = ([lon, lat]: Coordinates, [angle, meters]: [number, number], accuracy: number, at: number): Fix => {
  const [east, north] = [meters * Math.cos(angle), meters * Math.sin(angle)]
  const [jitteredLon, jitteredLat] = offset([lon, lat], east, north)
  return { lon: jitteredLon, lat: jitteredLat, accuracy, at }
}

test("walking a path with GPS wandering within its accuracy only ever gets further along, and never leaves it", () =>
  fc.assert(fc.property(
    path(90, 30),
    fc.double({ min: 0.8, max: 2, noNaN: true }),
    fc.integer({ min: 3, max: 12 }),
    fc.infiniteStream(jitter(1)),
    (line, speed, accuracy, wander) => {
      let progress: Progress | undefined
      for (let second = 0; speed * second <= line.length; second++) {
        const [angle, fraction] = wander.next().value as [number, number]
        const fix = fixAt(pointAt(line, speed * second).point, [angle, fraction * accuracy * 0.99], accuracy, second * 1000)
        const next = walkOn(line, fix, progress)
        expect(isOffPath(next)).toBe(false)
        expect(next.distance).toBeGreaterThanOrEqual(progress?.distance ?? 0)
        expect(Math.abs(next.distance - speed * second)).toBeLessThanOrEqual(2 * accuracy + 2)
        progress = next
      }
    }
  ))
)

test("stepping well off a walk for a few fixes plans a new way once, which is then followed back and on", () =>
  fc.assert(fc.property(
    path(30, 50),
    fc.double({ min: 0.2, max: 0.8, noNaN: true }),
    fc.integer({ min: 3, max: 12 }),
    fc.boolean(),
    fc.infiniteStream(jitter(3)),
    (original, along, away, isLeft, wander) => {
      const speed = 1.4
      let line = original
      let progress: Progress | undefined
      let at = 0
      let replans = 0
      const walkTo = (point: Coordinates) => {
        const next = walkOn(line, fixAt(point, wander.next().value as [number, number], 5, at += 1000), progress)
        progress = next
        if (isOffPath(next)) {
          // Planned again from where you are: back to the nearest of the walk, and on along it
          replans++
          const [lon, lat] = point
          line = toLine([point, ...sliceLine(original, nearestOnLine(original, { lat, lon }).distance, original.length)])
          progress = undefined
        }
      }

      const start = along * original.length
      for (let meters = 0; meters < start; meters += speed)
        walkTo(pointAt(original, meters).point)
      expect(replans).toBe(0)

      // 40 m off to one side, and standing there a while
      const { point, bearing } = pointAt(original, start)
      const side = (bearing + (isLeft ? -90 : 90)) * Math.PI / 180
      const off = offset(point, 40 * Math.sin(side), 40 * Math.cos(side))
      for (let i = 0; i < away; i++)
        walkTo(off)
      expect(replans).toBe(1)

      // Back to the walk and on to its end, on the new way
      for (let meters = 0; meters <= line.length; meters += speed) {
        walkTo(pointAt(line, meters).point)
        expect(progress?.missed).toBe(0)
      }
      expect(replans).toBe(1)
      expect(progress!.distance).toBeGreaterThan(line.length - 10)
    }
  ))
)
