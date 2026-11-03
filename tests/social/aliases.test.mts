import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import { ALIASES, NICKNAMES, otherNames, placeMatcher, shortNames } from "../../src/social/aliases.mts"
import type { Gazetteer } from "../../src/places/gazetteer.mts"
import { createPlaceSearch } from "../../src/places/search.mts"
import { CAMPUS } from "../../src/places/durham.mts"

const gazetteer: Gazetteer = JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8"))
const names = gazetteer.places.map(place => place.name)
const match = placeMatcher(names)

test("the calendars' venue strings name the places they mean, the longest name winning, whatever the case", () => {
  expect(match("MUB 164")).toBe("Memorial Union Building")
  expect(match("behind the mub")).toBe("Memorial Union Building")
  expect(match("Memorial Union Building 240 Strafford Room (MUB)")).toBe("Memorial Union Building")
  expect(match("Thompson Hall Lawn")).toBe("Thompson Hall Lawn")
  expect(match("T-Hall Lawn")).toBe("Thompson Hall Lawn")
  expect(match("Outside of T-hall on Main St")).toBe("Thompson Hall")
  expect(match("in front of hamilton smith")).toBe("Hamilton Smith Hall")
  expect(match("Durham, N.H., Lundholm Gymnasium")).toBe("Field House")
  expect(match("Durham, N.H., Whittemore Center at Key Auto Group Complex")).toBe("Whittemore Center Arena")
  expect(match("outside of hoco")).toBe("Holloway Commons")
  expect(match("Across Campus")).toBeUndefined()
  expect(match("")).toBeUndefined()
})

test("a name is matched as whole words, so a word inside another isn't a place", () => {
  expect(match("Hamel")).toBe("Hamel Rec Center")
  expect(match("Hamelton")).toBeUndefined()
  expect(match("MUBS")).toBeUndefined()
})

test("every alias stands for a place the gazetteer has", () => {
  for (const [alias, name] of Object.entries(ALIASES))
    expect(names, alias).toContain(name)
})

test("any gazetteer name or alias is found in any text around it, and text without one names nothing", () => {
  const known = [...names, ...Object.keys(ALIASES)]
  const target = new Map([...names.map(name => [name.toLowerCase(), name] as const), ...Object.entries(ALIASES).map(([alias, name]) => [alias.toLowerCase(), name] as const)])
  // Words that aren't places and can't be read as part of one
  const filler = fc.array(fc.constantFrom("room", "the", "at", "outside", "123", "floor", "&", "-", "..."), { maxLength: 4 }).map(words => words.join(" "))
  fc.assert(fc.property(fc.constantFrom(...known), filler, filler, fc.boolean(), (name, before, after, isUpper) => {
    const text = `${before} ${isUpper ? name.toUpperCase() : name} ${after}`
    const found = match(text)
    expect(found).toBeDefined()
    // The place found is the one named, or one whose name is longer and also in the text
    const expected = target.get(name.toLowerCase())
    if (found !== expected)
      expect(text.toLowerCase()).toContain(found!.toLowerCase())
  }))
  fc.assert(fc.property(filler, text => {
    expect(match(text)).toBeUndefined()
  }))
})

// What people type for places on campus, and the place each means
const TYPED: [string, string][] = [
  ["MUB",         "Memorial Union Building"],
  ["mub",         "Memorial Union Building"],
  ["HRC",         "Hamel Rec Center"],
  ["hamel",       "Hamel Rec Center"],
  ["hoco",        "Holloway Commons"],
  ["philly",      "Philbrook Hall"],
  ["philbrook",   "Philbrook Hall"],
  ["stillings",   "Stillings Hall"],
  ["paul",        "Paul College"],
  ["PCBE",        "Paul College"],
  ["pcac",        "Paul Creative Arts Center"],
  ["kingsbury",   "Kingsbury Hall"],
  ["parsons",     "Parsons Hall"],
  ["rudman",      "Rudman Hall"],
  ["morse",       "Morse Hall"],
  ["the whitt",   "Whittemore Center Arena"],
  ["whitt",       "Whittemore Center Arena"],
  ["t-hall",      "Thompson Hall"],
  ["t hall",      "Thompson Hall"],
  ["thompson",    "Thompson Hall"],
  ["field house", "Field House"],
  ["lundholm",    "Field House"],
  ["dimond",      "Dimond Library"],
  ["ham smith",   "Hamilton Smith Hall"]
]

const search = createPlaceSearch(gazetteer.places.map(({ name, at: [lon, lat] }) => ({ lat, lon, name })), CAMPUS, otherNames(names))

test.each(TYPED)("%s finds %s first", (typed, name) => {
  expect(search(typed)[0]?.name).toBe(name)
})

test("a hall or library is known by its first word, and nothing else is", () => {
  expect(shortNames(["Morse Hall", "Dimond Library", "Hamilton Smith Hall", "Thompson Hall Lawn", "Field House"]))
    .toEqual([["Morse", "Morse Hall"], ["Dimond", "Dimond Library"]])
})

test("every name an alias is given for is a place's, and every alias of the table is given", () => {
  const others = otherNames(names)
  for (const name of others.keys())
    expect(names).toContain(name)
  for (const [alias, name] of [...Object.entries(ALIASES), ...Object.entries(NICKNAMES)])
    expect(others.get(name), alias).toContain(alias)
  for (const aliases of others.values())
    expect(new Set(aliases).size).toBe(aliases.length)
  expect(otherNames(["Somewhere Else"], [["Elsewhere", "Somewhere Else"], ["Nowhere", "Not A Place"]])).toEqual(new Map([["Somewhere Else", ["Elsewhere"]]]))
})

test("a nickname is searched by but never read in an event's text, where it means something else", () => {
  expect(match("Philly cheesesteak night in HoCo")).toBe("Holloway Commons")
  expect(match("Talk by Dr. Paul Smith")).toBeUndefined()
  expect(match("St. Paul, Minn.")).toBeUndefined()
  for (const name of Object.values(NICKNAMES))
    expect(names).toContain(name)
})
