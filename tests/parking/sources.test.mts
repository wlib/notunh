import { test, expect } from "vitest"
import fc from "fast-check"
import * as v from "valibot"
import { AREAS } from "../../src/parking/areas.mts"
import { type Sources, ParkingData, checked, checkedAt, zoneTableUrl } from "../../src/parking/sources.mts"
import { cachedSources } from "./fixtures.mts"

const sources = await cachedSources()

test("the zone table PDF reads as UNH's 24 zones, each with its number, rate, max, days and hours", () => {
  expect(sources.table).toHaveLength(24)
  expect(sources.table.find(zone => zone.number === 98717)).toEqual({ name: "Sage Way Visitor Lot", number: 98717, rate: 1.85, max: 14, days: [0, 1, 2, 3, 4, 5, 6], hours: [420, 1260] })
  // Edgewood's row has its dots astray and Woodside's has no dash, as the PDF has them
  expect(sources.table.find(zone => zone.number === 98709)?.hours).toEqual([420, 1260])
  expect(sources.table.find(zone => zone.number === 98721)).toMatchObject({ max: 12, days: [0, 1, 2, 3, 4], hours: [420, 1080] })
})

test("the hand-kept areas agree with all three sources, and every area gets a point", () => {
  const { areas, problems } = checked(AREAS, sources)
  expect(problems).toEqual([])
  expect(areas).toHaveLength(AREAS.length)
  expect(areas.every(area => area.at.every(Number.isFinite))).toBe(true)
  // Where OpenStreetMap draws an area its middle is the point; where ParkMobile alone knows a zone, its display point
  expect(areas.find(area => area.id === "B")!.at).toEqual(sources.osm.find(element => element.id === "way/27805292")!.center)
  expect(areas.filter(area => area.guessed).every(area => !area.osm.length)).toBe(true)
})

/** One way the sources can come to disagree with the areas, and the zone or way it should be named by */
const aChange: fc.Arbitrary<[(sources: Sources) => Sources, string]> = fc.oneof(
  fc.tuple(fc.constantFrom(...sources.table), fc.constantFrom("rate", "max", "hours", "days")).map(([zone, field]): [(sources: Sources) => Sources, string] => [
    s => ({ ...s, table: s.table.map(each => each !== zone ? each : { ...each, [field]: field === "rate" ? each.rate + 0.25 : field === "max" ? each.max + 1 : field === "hours" ? [each.hours[0], each.hours[1] + 60] : [5] }) }),
    `${zone.number}`
  ]),
  fc.constantFrom(...sources.table).map((zone): [(sources: Sources) => Sources, string] => [s => ({ ...s, table: s.table.filter(each => each !== zone) }), "24"]),
  fc.constantFrom(...sources.parkMobile.filter(zone => AREAS.some(area => area.zone?.number === +zone.signageAreaCode))).map((zone): [(sources: Sources) => Sources, string] => [
    s => ({ ...s, parkMobile: s.parkMobile.map(each => each !== zone ? each : { ...each, status: "INACTIVE" }) }),
    zone.signageAreaCode
  ]),
  fc.constantFrom(...sources.parkMobile).map((zone): [(sources: Sources) => Sources, string] => [
    s => ({ ...s, parkMobile: [...s.parkMobile, { ...zone, signageAreaCode: "98799", parkingOperatorName: "University of New Hampshire" }] }),
    "98799"
  ]),
  fc.constantFrom(...AREAS.flatMap(area => area.osm)).map((id): [(sources: Sources) => Sources, string] => [s => ({ ...s, osm: s.osm.filter(element => element.id !== id) }), id])
)

test("any source that comes to disagree fails the check, naming what disagrees", () =>
  fc.assert(fc.property(aChange, ([change, named]) => {
    const { problems } = checked(AREAS, change(sources))
    expect(problems.some(problem => problem.includes(named))).toBe(true)
  }), { numRuns: 200 })
)

test("an area's point far from ParkMobile's for its zone is a problem", () => {
  const moved = AREAS.map(area => area.id === "sage-way" ? { ...area, at: [area.at![0] + 0.01, area.at![1]] as [number, number] } : area)
  expect(checked(moved, sources).problems).toEqual([expect.stringMatching(/^Sage Way Visitor Lot is \d+ m from ParkMobile's point for zone 98717$/)])
})

test("the file a page loads keeps each source's time apart from when it was built, and says it was checked when its oldest source was", () => {
  const data = v.parse(ParkingData, { sources: { zones: 3, parkMobile: 2, osm: 5 }, built: 9, areas: checked(AREAS, sources).areas })
  expect(checkedAt(data)).toBe(2)
})

test("the visitor page's link to the zone table is found wherever the year's upload puts it", () => {
  expect(zoneTableUrl(`<a href="/transportation/sites/default/files/media/2026-03/parking-meter-info.pdf">Rates</a>`))
    .toBe("https://www.unh.edu/transportation/sites/default/files/media/2026-03/parking-meter-info.pdf")
  expect(zoneTableUrl(`<a href="/other.pdf">`)).toBeUndefined()
})
