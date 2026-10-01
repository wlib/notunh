import { test, expect } from "vitest"
import fc from "fast-check"
import { addDays, distance, isServiceActive, localDate, serviceDayStart, type Service } from "../../src/map/feed.mts"

const date = fc
  .date({ min: new Date("2000-01-01T12:00:00Z"), max: new Date("2099-12-31T12:00:00Z"), noInvalidDate: true })
  .map(d => d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate())

test("a service day's noon is on that local date", () =>
  fc.assert(fc.property(date, d => {
    expect(localDate(serviceDayStart(d) + 12 * 3600_000)).toBe(d)
  }))
)

test("service days are 23, 24, or 25 hours apart", () =>
  fc.assert(fc.property(date, d => {
    const hours = (serviceDayStart(addDays(d, 1)) - serviceDayStart(d)) / 3600_000
    expect([23, 24, 25]).toContain(hours)
  }))
)

test("addDays round trips and is monotone", () =>
  fc.assert(fc.property(date, fc.integer({ min: -400, max: 400 }), (d, n) => {
    expect(addDays(addDays(d, n), -n)).toBe(d)
    expect(Math.sign(addDays(d, n) - d)).toBe(Math.sign(n))
  }))
)

const service = fc.record({
  days:    fc.nat({ max: 127 }),
  start:   date,
  end:     date,
  added:   fc.array(date, { maxLength: 3 }),
  removed: fc.array(date, { maxLength: 3 })
})

test("isServiceActive: removed beats added beats the weekly calendar", () =>
  fc.assert(fc.property(service, date, (service: Service, d) => {
    const weekday = (new Date(Date.UTC(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100)).getUTCDay() + 6) % 7
    const expected =
      service.removed.includes(d) ? false :
      service.added.includes(d)   ? true :
      d >= service.start && d <= service.end && (service.days & (1 << weekday)) !== 0
    expect(isServiceActive(service, d)).toBe(expected)
  }))
)

const point = fc.record({
  lat: fc.double({ min: 42.9, max: 43.4, noNaN: true }),
  lon: fc.double({ min: -71.2, max: -70.6, noNaN: true })
})

test("distance is a metric", () =>
  fc.assert(fc.property(point, point, point, (a, b, c) => {
    expect(distance(a, a)).toBe(0)
    expect(distance(a, b)).toBeCloseTo(distance(b, a), 6)
    expect(distance(a, c)).toBeLessThanOrEqual(distance(a, b) + distance(b, c) + 1e-6)
  }))
)
