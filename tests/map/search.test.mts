import { test, expect } from "vitest"
import fc from "fast-check"
import { createPlaceSearch } from "../../src/map/search.mts"

const CENTER = { lat: 43.135, lon: -70.93 }

const place = (name: string, lat = 43.135) => ({ lat, lon: -70.93, name })

const searchOf = (places: { lat: number, lon: number, name: string }[]) =>
  createPlaceSearch(places, CENTER)

const names = (places: { name: string }[]) =>
  places.map(({ name }) => name)

test("a place named exactly as searched comes first, before longer names starting the same", () => {
  const search = searchOf(["Hamilton Smith Hall Annex", "Smith Hall", "Hamilton Smith Hall"].map(name => place(name)))
  expect(names(search("hamilton smith hall"))).toEqual(["Hamilton Smith Hall", "Hamilton Smith Hall Annex"])
  expect(names(search("Smith Hall"))[0]).toBe("Smith Hall")
})

test("each name is found once, as the place by it nearest the middle of town, whichever is listed first", () => {
  const far = place("Aroma Joe's", 43.08)
  const near = place("Aroma Joe's", 43.1352)
  expect(searchOf([far, near])("aroma joe")).toEqual([near])
  expect(searchOf([near, far])("aroma joe")).toEqual([near])
  expect(searchOf([near, far])(" ")).toEqual([])
})

// Names of a few made-up words, distinct, as "Dorvane Hall", though never starting with a doubled letter, as uFuzzy
// looks past a word's first letter only where the next differs, to find "Test" in "ManifestTest" rather than "tTest"
const word = fc.stringMatching(/^[A-Z][a-z]{5,9}$/).filter(word => word[0].toLowerCase() !== word[1])
const gazetteer = fc.uniqueArray(fc.array(word, { minLength: 1, maxLength: 3 }).map(words => words.join(" ")), {
  minLength: 1,
  maxLength: 12,
  comparator: (a, b) => a.toLowerCase() === b.toLowerCase()
})

test("every place is found first by its own name, in any case", () =>
  fc.assert(fc.property(gazetteer, fc.boolean(), (all, isLower) => {
    const search = searchOf(all.map(name => place(name)))
    for (const name of all)
      expect(names(search(isLower ? name.toLowerCase() : name.toUpperCase()))[0]).toBe(name)
  }))
)

test("a place is found by the start of its name with a typo in it", () =>
  fc.assert(fc.property(
    gazetteer.chain(all => fc.record({
      all:   fc.constant(all),
      name:  fc.constantFrom(...all),
      typo:  fc.nat(),
      kind:  fc.constantFrom("swap", "drop", "change"),
      extra: fc.integer({ min: 0, max: 2 })
    })),
    ({ all, name, typo, kind, extra }) => {
      // Some of its first word, typed with one slip after the first letter, as "Dovrane" or "Dorane" or "Doxvane"
      const start = name.split(" ")[0].slice(0, 5 + extra).toLowerCase()
      const at = 1 + typo % (start.length - 2)
      const typed =
        kind === "swap" ? start.slice(0, at) + start[at + 1] + start[at] + start.slice(at + 2) :
        kind === "drop" ? start.slice(0, at) + start.slice(at + 1) :
                          start.slice(0, at) + (start[at] === "x" ? "q" : "x") + start.slice(at + 1)
      const search = searchOf(all.map(name => place(name)))
      expect(names(search(typed))).toContain(name)
    }
  ))
)
