import { test, expect } from "vitest"
import fc from "fast-check"
import { bearing, distance, frame, project, ruler, segmentMeters } from "../../src/geo/projection.mts"

// The Seacoast, where everything the app measures is
const point = fc.record({
  lat: fc.double({ min: 42.9, max: 43.4, noNaN: true }),
  lon: fc.double({ min: -71.2, max: -70.6, noNaN: true })
})

test("distance is symmetric, zero to itself, and the same whether points are objects or coordinates", () =>
  fc.assert(fc.property(point, point, (a, b) => {
    expect(distance(a, a)).toBe(0)
    expect(distance(a, b)).toBe(distance(b, a))
    expect(segmentMeters([a.lon, a.lat], [b.lon, b.lat])).toBe(distance(a, b))
  }))
)

test("distance is within a third of a percent of a sphere's great circle, and of the meters per degree at either end", () =>
  fc.assert(fc.property(point, point, (a, b) => {
    const radians = Math.PI / 180
    const h = Math.sin((b.lat - a.lat) * radians / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin((b.lon - a.lon) * radians / 2) ** 2
    // A sphere of the Earth's mean radius, which the ellipsoid is a few parts in a thousand from around here
    const spherical = 2 * 6_371_008.8 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
    expect(Math.abs(distance(a, b) - spherical)).toBeLessThanOrEqual(spherical * 3e-3 + 1e-3)
    for (const end of [a, b]) {
      const { kx: x, ky: y } = ruler(end.lat)
      const flat = Math.hypot((b.lon - a.lon) * x, (b.lat - a.lat) * y)
      expect(Math.abs(distance(a, b) - flat)).toBeLessThanOrEqual(flat * 3e-3 + 1e-3)
    }
  }))
)

test("a frame around an origin measures what distance does for some kilometers around, and goes back to the same coordinates", () =>
  fc.assert(fc.property(point, point, (origin, other) => {
    const { toMeters, toCoordinates } = frame([origin.lon, origin.lat])
    const meters = toMeters([other.lon, other.lat])
    if (distance(origin, other) <= 5000)
      expect(Math.abs(Math.hypot(...meters) - distance(origin, other))).toBeLessThanOrEqual(distance(origin, other) * 1e-3 + 1e-3)
    const [lon, lat] = toCoordinates(meters)
    expect(lon).toBeCloseTo(other.lon, 9)
    expect(lat).toBeCloseTo(other.lat, 9)
  }))
)

test("projecting some meters along a bearing lands that far away, that way", () =>
  fc.assert(fc.property(point, fc.double({ min: 0, max: 360, noNaN: true }), fc.double({ min: 1, max: 5000, noNaN: true }), ({ lat, lon }, degrees, meters) => {
    const there = project([lon, lat], degrees, meters)
    // Measured flat from the start rather than from halfway, short by the square of the distance: up to 0.71 m over
    // 5 km at the Seacoast's north edge on a diagonal bearing
    expect(Math.abs(segmentMeters([lon, lat], there) - meters)).toBeLessThanOrEqual(meters ** 2 * 4e-8 + 0.01)
    const turned = (bearing([lon, lat], there) - degrees + 540) % 360 - 180
    expect(Math.abs(turned)).toBeLessThan(0.01)
  }))
)
