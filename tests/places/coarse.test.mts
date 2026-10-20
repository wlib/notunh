import { test, expect } from "vitest"
import fc from "fast-check"
import { coarseName } from "../../src/places/coarse.mts"
import type { Place } from "../../src/places/search.mts"

const HALL: Place = { lat: 43.1352, lon: -70.9339, name: "Holloway Commons" }
const STOPS: Place[] = [{ lat: 43.1361, lon: -70.9330, name: "Campus Crossing" }, { lat: 43.1440, lon: -70.9420, name: "Gables" }]
const NAMED = [HALL, ...STOPS]

test("a named building or stop is counted by its name, and anywhere else by the nearest stop within a few minutes' walk", () => {
  expect(coarseName(HALL, NAMED, STOPS)).toBe("Holloway Commons")
  expect(coarseName(STOPS[1], NAMED, STOPS)).toBe("Gables")
  // Where you are, though beside the hall, and a place sharing a named one's name elsewhere
  expect(coarseName({ ...HALL, name: "Your location", isYou: true }, NAMED, STOPS)).toBe("Campus Crossing")
  expect(coarseName({ ...STOPS[1], lat: STOPS[1].lat + 0.0005, name: "Holloway Commons" }, NAMED, STOPS)).toBe("Gables")
  expect(coarseName({ lat: 43.2, lon: -70.9, name: "12 Main St" }, NAMED, STOPS)).toBe("elsewhere")
})

test("whatever a place is called, it's counted by a named place's or stop's name, or as elsewhere, never its own", () =>
  fc.assert(fc.property(fc.double({ min: 43.12, max: 43.16, noNaN: true }), fc.double({ min: -70.96, max: -70.91, noNaN: true }), fc.string(), (lat, lon, name) => {
    const counted = coarseName({ lat, lon, name }, NAMED, STOPS)
    expect([...NAMED.map(place => place.name), "elsewhere"]).toContain(counted)
  }))
)
