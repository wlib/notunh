import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import * as v from "valibot"
import { ADDED, RENAMED, withAdded } from "../../src/places/added.mts"
import { Gazetteer, type GazetteerPlace, placeAt } from "../../src/places/gazetteer.mts"
import { boxOf, holds } from "../../src/geo/boxes.mts"

// The gazetteer as the fixtures' extract has it, and as the map loads it
const raw: { places: GazetteerPlace[] } = JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8"))
const { places } = v.parse(Gazetteer, raw)

const NAMES = [...ADDED.map(place => place.name), ...Object.values(RENAMED)]

test("every added place is a building with an outline, its extent around it, and its doors on it", () => {
  for (const { name, kind, at: [lon, lat], extent, outline, entrances } of ADDED) {
    expect(kind, name).toBe("building")
    expect(boxOf(outline!.flat()), name).toEqual(extent)
    expect(holds(extent!, { lon, lat }), name).toBe(true)
    for (const door of entrances ?? [])
      expect(outline!.flat(), name).toContainEqual(door)
  }
})

test("a tap on an added place's middle names it, as it's on the map", () => {
  for (const { name, at: [lon, lat] } of ADDED)
    expect(placeAt(places, { lon, lat })?.name).toBe(name)
})

test("each added or corrected name is one place's, and no other place's on the map", () => {
  expect(new Set(NAMES).size).toBe(NAMES.length)
  for (const name of NAMES)
    expect(places.filter(place => place.name === name), name).toHaveLength(1)
  for (const name of Object.keys(RENAMED))
    expect(NAMES).not.toContain(name)
})

test("a misnamed place is renamed, keeping its shape, and its old name is gone from the map", () => {
  for (const [wrong, right] of Object.entries(RENAMED)) {
    const upstream = raw.places.find(place => place.name === wrong)!
    expect(upstream, wrong).toBeDefined()
    expect(places.find(place => place.name === right)).toEqual({ ...upstream, name: right })
    expect(places.map(place => place.name)).not.toContain(wrong)
  }
})

test("a place OpenStreetMap names or spells rightly itself is left as it has it, and the rest as they were", () => {
  const place = fc.record({
    name: fc.string({ minLength: 1 }),
    kind: fc.constantFrom("building", "cafe"),
    at:   fc.tuple(fc.double({ noNaN: true }), fc.double({ noNaN: true }))
  })
  fc.assert(fc.property(fc.array(place), fc.subarray(NAMES), (others, named) => {
    const upstream = [...others.filter(place => !Object.hasOwn(RENAMED, place.name) && !NAMES.includes(place.name)), ...named.map(name => ({ name, kind: "building", at: [0, 0] as [number, number] }))]
    const loaded = withAdded(upstream)
    for (const place of upstream)
      expect(loaded).toContainEqual(place)
    for (const name of named)
      expect(loaded.filter(place => place.name === name)).toHaveLength(1)
    expect(loaded).toHaveLength(upstream.length + ADDED.filter(place => !named.includes(place.name)).length)
    expect(withAdded(loaded)).toEqual(loaded)
  }))
})

test("the added places are in Durham, near the campus or, the estuarine lab, at Adams Point", () => {
  for (const { name, at: [lon, lat] } of ADDED)
    expect(holds([-70.99, 43.08, -70.86, 43.17], { lon, lat }), name).toBe(true)
})
