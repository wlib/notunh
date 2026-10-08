import { test, expect } from "vitest"
import fc from "fast-check"
import { distance, isServiceActive, serviceDayStart, type Service } from "../../src/map/feed.mts"
import { HOUR, localDay, weekday } from "../../src/shared/time.mts"

const day = fc
  .date({ min: new Date("2000-01-01T12:00:00Z"), max: new Date("2099-12-31T12:00:00Z"), noInvalidDate: true })
  .map(date => date.toISOString().slice(0, 10))

test("a service day's noon is on that day in Durham", () =>
  fc.assert(fc.property(day, d => {
    expect(localDay(serviceDayStart(d) + 12 * HOUR)).toBe(d)
  }))
)

const service = fc.record({
  days:    fc.nat({ max: 127 }),
  start:   day,
  end:     day,
  added:   fc.array(day, { maxLength: 3 }),
  removed: fc.array(day, { maxLength: 3 })
})

test("isServiceActive: removed beats added beats the weekly calendar", () =>
  fc.assert(fc.property(service, day, (service: Service, d) => {
    const expected =
      service.removed.includes(d) ? false :
      service.added.includes(d)   ? true :
      d >= service.start && d <= service.end && (service.days & (1 << weekday(d))) !== 0
    expect(isServiceActive(service, d)).toBe(expected)
  }))
)

const point = fc.record({
  lat: fc.double({ min: 42.9, max: 43.4, noNaN: true }),
  lon: fc.double({ min: -71.2, max: -70.6, noNaN: true })
})

test("distance is symmetric and approximates great-circle distance locally", () =>
  fc.assert(fc.property(point, point, (a, b) => {
    expect(distance(a, a)).toBe(0)
    expect(distance(a, b)).toBeCloseTo(distance(b, a), 6)
    const radians = Math.PI / 180
    const h = Math.sin((b.lat - a.lat) * radians / 2) ** 2
      + Math.cos(a.lat * radians) * Math.cos(b.lat * radians)
      * Math.sin((b.lon - a.lon) * radians / 2) ** 2
    const spherical = 2 * 6_371_000 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
    // The flat-earth formula is accurate to 0.01% in this region, but is not an exact metric.
    expect(Math.abs(distance(a, b) - spherical)).toBeLessThanOrEqual(spherical * 1e-4 + 1e-6)
  }))
)
