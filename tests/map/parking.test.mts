import { test, expect } from "vitest"
import fc from "fast-check"
import { AFTER, EARLY, STAY, defaultStay, purposeOfVisit, readPermit, stayOfVisit } from "../../src/map/state/parking.mts"

const anInstant = fc.integer({ min: Date.now() - 400 * 86_400_000, max: Date.now() + 400 * 86_400_000 })

test("a stay asked for with none is two hours from the minute it was asked", () =>
  fc.assert(fc.property(anInstant, now => {
    const { from, to } = defaultStay(now)
    expect(from % 60_000).toBe(0)
    expect(now - from).toBeLessThan(60_000)
    expect(to - from).toBe(STAY)
  }))
)

test("a class's stay runs from a little before it to a little after it ends, and an open-ended visit's for two hours", () =>
  fc.assert(fc.property(anInstant, fc.constantFrom(0, 300_000, 600_000), fc.option(fc.integer({ min: 1, max: 4 * 60 }), { nil: undefined }), (arriveBy, offset, length) => {
    const until = length === undefined ? undefined : arriveBy + length * 60_000
    const stay = stayOfVisit({ arriveBy, offset, until })
    expect(stay.from).toBe(arriveBy - offset - EARLY)
    expect(stay.to).toBe(until === undefined ? stay.from + STAY : until + AFTER)
    expect(stay.to).toBeGreaterThan(stay.from)
  }))
)

test("what a visit's parking is for: a class's, an event's, or a plain visit", () => {
  expect(purposeOfVisit({ occurrence: { id: "course:202610:12496:2026-10-27:abc", title: "CS 518" } })).toBe("class")
  expect(purposeOfVisit({ occurrence: { id: "pin-1", title: "Tennis" } })).toBe("event")
  expect(purposeOfVisit({})).toBe("visit")
})

test("a permit stored reads back only as one parking knows", () => {
  expect(readPermit("faculty")).toBe("faculty")
  expect(readPermit({ resident: "E" })).toEqual({ resident: "E" })
  for (const junk of [null, "", "staff", { resident: 1 }, 7])
    expect(readPermit(junk)).toBeUndefined()
})
