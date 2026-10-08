import { test, expect } from "vitest"
import fc from "fast-check"
import { confidence } from "../../src/map/buses.mts"

test("confidence is full for a fresh report, fades as it ages, and never fades away", () => {
  fc.assert(fc.property(fc.double({ min: -60, max: 3600, noNaN: true }), fc.double({ min: 0, max: 3600, noNaN: true }), (age, more) => {
    expect(confidence(age + more)).toBeLessThanOrEqual(confidence(age))
    expect(confidence(age)).toBeGreaterThanOrEqual(0.3)
    expect(confidence(age)).toBeLessThanOrEqual(1)
  }))
  expect(confidence(0)).toBe(1)
})
