import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import * as v from "valibot"
import { CHAPTERS, aliasesOf, chapterNamed, isPlaced, withChapters } from "../../src/places/chapters.mts"
import { Gazetteer, type GazetteerPlace } from "../../src/places/gazetteer.mts"
import { createNameSearch, createPlaceSearch } from "../../src/places/search.mts"
import { spellGreek } from "../../src/shared/fuzzy.mts"
import { distance } from "../../src/geo/projection.mts"

const CAMPUS = { lat: 43.1365, lon: -70.9345 }

// The gazetteer as the map loads it, from the extract the fixtures were made from, with the chapters' houses joined
const raw: { places: GazetteerPlace[] } = JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8"))
const { places } = v.parse(Gazetteer, raw)

const placed = CHAPTERS.filter(isPlaced)
const unplaced = CHAPTERS.filter(chapter => !isPlaced(chapter))
const search = createPlaceSearch(
  places.map(({ name, at: [lon, lat] }) => ({ lat, lon, name })),
  CAMPUS,
  new Map(placed.map(chapter => [chapter.name, aliasesOf(chapter)]))
)
const searchUnplaced = createNameSearch(unplaced.map(chapter => [chapter.name, ...aliasesOf(chapter)]))

/** A name as two spellings of it compare, in letters alone, Greek letters spelled out */
const bare = (name: string) =>
  spellGreek(name).toLowerCase().replace(/[^a-z0-9]/g, "")

/** Every name a chapter is searched by, its own among them */
const namesOf = (chapter: typeof CHAPTERS[number]) =>
  [chapter.name, ...aliasesOf(chapter)]

/** A name as someone might type it: in any case, with spaces around */
const typed = (name: string) =>
  fc.record({ upper: fc.boolean(), before: fc.constantFrom("", " ", "  "), after: fc.constantFrom("", " ") })
    .map(({ upper, before, after }) => before + (upper ? name.toUpperCase() : name.toLowerCase()) + after)

const named = (chapters: typeof CHAPTERS) =>
  fc.constantFrom(...chapters).chain(chapter => fc.constantFrom(...namesOf(chapter)).chain(typed).map(query => ({ chapter, query })))

test("each chapter's name is its letters spelled out, as UNH names them", () => {
  for (const chapter of CHAPTERS)
    expect(spellGreek(chapter.letters)).toBe(chapter.name)
})

test("no two chapters share a name, letters or nickname, however it's spelled", () => {
  const owners = new Map<string, string>()
  for (const chapter of CHAPTERS)
    for (const name of new Set(namesOf(chapter).map(bare))) {
      expect(owners.get(name), `${name} is ${owners.get(name)}'s and ${chapter.name}'s`).toBeUndefined()
      owners.set(name, chapter.name)
    }
})

test("every name of a placed chapter finds its house first, in any case", () =>
  fc.assert(fc.property(named(placed), ({ chapter, query }) => {
    expect(search(query)[0]?.name).toBe(chapter.name)
  }))
)

test("every name of a chapter the map doesn't place finds it first among those", () =>
  fc.assert(fc.property(named(unplaced), ({ chapter, query }) => {
    expect(unplaced[searchUnplaced(query)[0]?.index]).toBe(chapter)
  }))
)

test("a chapter is found by its letters in small letters too, and its name with a typo in it", () => {
  expect(search("σχ")[0]?.name).toBe("Sigma Chi")
  expect(search("ΑΧΩ")[0]?.name).toBe("Alpha Chi Omega")
  expect(search("lamda chi")[0]?.name).toBe("Lambda Chi Alpha")
  expect(search("pike")[0]?.name).toBe("Pi Kappa Alpha")
  expect(unplaced[searchUnplaced("teke")[0].index].name).toBe("Tau Kappa Epsilon")
})

test("each placed chapter's house is one place in the gazetteer, in Durham, in place of what OpenStreetMap named it", () => {
  for (const chapter of placed) {
    const houses = places.filter(place => place.name === chapter.name)
    expect(houses).toHaveLength(1)
    const [lon, lat] = houses[0].at
    expect(distance({ lon, lat }, CAMPUS)).toBeLessThan(1500)
  }
  // The building OpenStreetMap names "AGR ( Alpha Gamma Rho)" is the chapter's house, outline and all, and the point
  // it names Pi Kappa Phi is that chapter's
  expect(places.some(place => place.name.startsWith("AGR"))).toBe(false)
  expect(places.find(place => place.name === "Alpha Gamma Rho")?.outline).toBeDefined()
  expect(places.filter(place => place.name === "Pi Kappa Phi")).toHaveLength(1)
  expect(chapterNamed("Pi Kappa Phi")).toBeDefined()
})

test("joining the chapters again changes nothing, and leaves every other place as it was", () => {
  expect(withChapters(places)).toEqual(places)
  const names = new Set(places.map(place => place.name))
  expect(raw.places.filter(place => !names.has(place.name)).map(place => place.name)).toEqual(["AGR ( Alpha Gamma Rho)", "Elizabeth Demeritt House"])
})

test("a chapter's house far from any building, as a point alone, is placed where the chapters list says", () =>
  fc.assert(fc.property(fc.constantFrom(...placed), chapter => {
    const [house] = withChapters([]).filter(place => place.name === chapter.name)
    expect(house).toEqual({ name: chapter.name, kind: "building", at: chapter.house.at })
  }))
)
