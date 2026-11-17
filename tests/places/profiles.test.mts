// Buildings' profiles (src/places/profiles.mts): the records kept in src/places/profiles/ made into what the map
// shows, keyed by the gazetteer's names, every problem with them found; the overall rating and rank worked out from
// the six scores; when a building was last renovated; photos' addresses, theirs and the Worker's for
// them; and profiled buildings found in search by their other names

import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import * as v from "valibot"
import { CATEGORIES, DIMENSIONS, PHOTO_WIDTHS, STATUSES, WEIGHTS, type Category, type Judged, type Status, eraParts, lastRenovated, ordinal, overallOf, photoSrc, profilesOf, ratingText, searchNamesOf, statusText } from "../../src/places/profiles.mts"
import { Gazetteer } from "../../src/places/gazetteer.mts"
import { createPlaceSearch } from "../../src/places/search.mts"
import { CAMPUS } from "../../src/places/durham.mts"
import { distance } from "../../src/geo/projection.mts"
import { readRecords } from "../../scripts/map/profiles.mts"

const { places } = v.parse(Gazetteer, JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8")))
const NAMES = new Set(places.map(({ name }) => name))
const RECORDS = await readRecords()
const MADE = profilesOf(RECORDS, NAMES)

const year = fc.integer({ min: 1700, max: 2100 })
const text = fc.stringMatching(/^[A-Za-z][A-Za-z ,.]{0,30}[a-z]$/)
const link = fc.webUrl({ validSchemes: ["https"] })
/** A photo's address as a record may have it, on Commons or Flickr */
const photoUrl = fc.tuple(
  fc.constantFrom("https://upload.wikimedia.org/wikipedia/commons/", "https://thumb.wikimedia.org/wikipedia/commons/thumb/", "https://live.staticflickr.com/"),
  fc.stringMatching(/^[A-Za-z0-9_%,()\/-]{1,30}\.jpg(\?utm_source=commons)?$/)
).map(parts => parts.join(""))

const scores = fc.record(Object.fromEntries(DIMENSIONS.map(dimension => [dimension, fc.integer({ min: 1, max: 10 })])) as Record<typeof DIMENSIONS[number], fc.Arbitrary<number>>)

/** A renovation as the records have them, dated or not, said to be major or not */
const renovation = fc.record({
  year:  fc.option(year, { nil: undefined }),
  what:  text,
  major: fc.boolean(),
  src:   fc.constant<string[]>(["s1"])
}, { requiredKeys: ["what", "major", "src"] })

/** A judged record of a building, at a place among those given or none, its facts citing its one source or, if dangling, another */
const record = (names: readonly string[], dangling: fc.Arbitrary<boolean> = fc.constant(false)): fc.Arbitrary<Judged> =>
  fc.record({
    name:        text,
    place:       names.length ? fc.option(fc.constantFrom(...names), { nil: null }) : fc.constant(null),
    category:    fc.constantFrom(...Object.keys(CATEGORIES) as Category[]),
    built:       fc.option(year, { nil: undefined }),
    renovations: fc.array(renovation, { maxLength: 3 }),
    facts:       fc.array(text, { maxLength: 6 }),
    dangling,
    ratings:     fc.option(scores, { nil: undefined }),
    status:      fc.constantFrom(...Object.keys(STATUSES) as Status[]),
    confidence:  fc.constantFrom("high", "med", "low"),
    photos:      fc.array(fc.record({ url: photoUrl, page: link, credit: text, license: fc.constantFrom("CC BY-SA 4.0", "CC0", "Public domain"), view: fc.constantFrom("exterior", "interior"), caption: text }), { maxLength: 3 })
  }).map(({ facts, dangling, ...rest }) => ({
    ...rest,
    aliases: [],
    more:    [],
    facts:   facts.map((fact, i) => ({ text: fact, src: [dangling && i === 0 ? "s9" : "s1"] })),
    sources: { s1: { title: "A source", url: "https://example.com/" } }
  }))

test("every record is one, at a place the map names or none, and makes a profile whose facts cite sources it has and whose photos are Wikimedia's or Flickr's", () => {
  expect(MADE.problems).toEqual([])
  expect(Object.keys(MADE.data.profiles)).toHaveLength(RECORDS.length - RECORDS.filter(([, { place }]) => place === null).length)
  for (const [place, profile] of Object.entries(MADE.data.profiles)) {
    expect(NAMES.has(place)).toBe(true)
    for (const { src } of profile.facts)
      for (const id of src)
        expect(profile.sources, `${place} cites ${id}`).toHaveProperty(id)
    for (const { url, page } of profile.photos) {
      expect(url).toMatch(/^https:\/\/(upload\.wikimedia\.org|thumb\.wikimedia\.org|live\.staticflickr\.com)\//)
      expect(page).toMatch(/^https:\/\/(commons\.wikimedia\.org|www\.flickr\.com)\//)
    }
  }
})

test("the buildings rated are ranked by overall, the best first and equals sharing a rank, among every record rated, on the map or not", () => {
  const rated = RECORDS.filter(([, { ratings }]) => ratings !== undefined)
  expect(MADE.data.ranked).toBe(rated.length)
  const ranked = Object.values(MADE.data.profiles).flatMap(({ rating }) => rating ? [rating] : []).sort((a, b) => a.rank - b.rank)
  expect(ranked.length).toBeLessThanOrEqual(rated.length)
  expect(ranked[0].rank).toBe(1)
  for (const [i, rating] of ranked.entries()) {
    expect(rating.overall).toBe(overallOf(rating))
    if (i > 0) {
      expect(rating.overall).toBeLessThanOrEqual(ranked[i - 1].overall)
      expect(rating.rank === ranked[i - 1].rank).toBe(rating.overall === ranked[i - 1].overall)
    }
  }
})

test("the overall is the scores' weighted mean to a tenth, never below the least score nor above the greatest, and never falls as a score rises", () =>
  fc.assert(fc.property(scores, fc.constantFrom(...DIMENSIONS), (scores, dimension) => {
    const overall = overallOf(scores)
    expect(overall * 10).toBe(Math.round(overall * 10))
    expect(overall).toBeGreaterThanOrEqual(Math.min(...Object.values(scores)))
    expect(overall).toBeLessThanOrEqual(Math.max(...Object.values(scores)))
    expect(Math.abs(overall - DIMENSIONS.reduce((sum, d) => sum + scores[d] * WEIGHTS[d], 0) / 20)).toBeLessThanOrEqual(0.05 + 1e-9)
    if (scores[dimension] < 10)
      expect(overallOf({ ...scores, [dimension]: scores[dimension] + 1 })).toBeGreaterThanOrEqual(overall)
  }))
)

test("profiles are keyed by every record's place the map names, once, records for none ranked but left out, and every other place is a problem", () =>
  fc.assert(fc.property(fc.array(record(["Thompson Hall", "Stoke Hall", "Hamilton Smith Hall", "Nowhere Hall"]), { maxLength: 8 }), records => {
    const { data, problems } = profilesOf(records.map((record, i) => [`${i}.json`, record]), NAMES)
    const placed = records.flatMap(({ place }) => place === null ? [] : [place])
    const known = placed.filter(name => NAMES.has(name))
    expect(Object.keys(data.profiles).toSorted()).toEqual([...new Set(known)].toSorted())
    expect(problems.length).toBe(placed.length - new Set(known).size)
    const overalls = records.flatMap(({ ratings }) => ratings ? [overallOf(ratings)] : [])
    expect(data.ranked).toBe(overalls.length)
    for (const profile of Object.values(data.profiles))
      if (profile.rating)
        expect(profile.rating.rank).toBe(1 + overalls.filter(overall => overall > profile.rating!.overall).length)
  }))
)

test("a fact citing a source its record doesn't have, or a record that isn't one, is a problem naming the file", () =>
  fc.assert(fc.property(record(["Thompson Hall"], fc.boolean()), fc.constantFrom("name", "category", "sources", "confidence"), (judged, broken) => {
    const dangling = judged.facts[0]?.src[0] === "s9"
    const { problems, data } = profilesOf([["a.json", judged]], NAMES)
    expect(problems.some(problem => problem.startsWith("a.json: fact 1 cites s9"))).toBe(dangling)
    for (const profile of Object.values(data.profiles))
      expect(profile.facts.every(({ src }) => src.every(id => id in profile.sources))).toBe(!dangling)
    const { problems: others } = profilesOf([["a.json", { ...judged, [broken]: 7 }]], NAMES)
    expect(others).toHaveLength(1)
    expect(others[0]).toMatch(new RegExp(`^a\\.json: ${broken}`))
  }))
)

test("a building was last renovated by its latest major renovation dated after it was built, if any", () =>
  fc.assert(fc.property(fc.option(year, { nil: undefined }), fc.array(renovation, { maxLength: 5 }), (built, renovations) => {
    const majors = renovations.flatMap(({ major, year }) => major && year !== undefined && (built === undefined || year > built) ? [year] : [])
    expect(lastRenovated({ built, renovations })).toBe(majors.length ? Math.max(...majors) : undefined)
    expect(eraParts({ built, renovated: lastRenovated({ built, renovations }) })).toEqual([...built === undefined ? [] : [`Built ${built}`], ...majors.length ? [`renovated ${Math.max(...majors)}`] : []])
  }))
)

test("a rating reads as its overall of ten and rank, low confidence said, or nothing unrated", () =>
  fc.assert(fc.property(scores, fc.integer({ min: 1, max: 200 }), fc.integer({ min: 0, max: 200 }), fc.constantFrom("high", "med", "low"), (scores, rank, below, confidence) => {
    const rating = { ...scores, overall: overallOf(scores), rank }
    expect(ratingText({ rating, confidence }, rank + below)).toBe(`${rating.overall} of 10 · ${ordinal(rank)} of ${rank + below}${confidence === "low" ? " · low confidence" : ""}`)
    expect(ratingText({ confidence }, rank + below)).toBeUndefined()
  }))
)

test("how a building stands is said unless it's in use, with its note", () => {
  expect(statusText({ status: "in-use", statusNote: "Open" })).toBeUndefined()
  expect(statusText({ status: "closed", statusNote: "Since spring" })).toBe("Closed: Since spring")
  expect(statusText({ status: "demolished" })).toBe("Demolished")
})

test("a photo is asked of the Worker by its address as published, at a width, and one anywhere but Commons or Flickr isn't a record's", () =>
  fc.assert(fc.property(
    record([]), photoUrl, fc.constantFrom(...PHOTO_WIDTHS),
    fc.oneof(fc.webUrl(), fc.constantFrom("http://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg", "https://upload.wikimedia.org.example.com/wikipedia/commons/a/ab/X.jpg", "https://upload.wikimedia.org/wikipedia/en/a/ab/X.jpg")),
    (judged, url, width, elsewhere) => {
      expect([...new URL(photoSrc(url, width), "https://notunh.app").searchParams]).toEqual([["src", url], ["w", String(width)]])
      const problemsWith = (url: string) =>
        profilesOf([["a.json", { ...judged, photos: [{ url, page: url, credit: "A", license: "CC0", view: "exterior", caption: "A" }] }]], NAMES).problems
      expect(problemsWith(url)).toEqual([])
      expect(problemsWith(elsewhere)).toEqual([expect.stringMatching(/^a\.json: photos\.0\.url/)])
    }
  ))
)

test("ranks read as ordinals", () => {
  expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 83, 101].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "83rd", "101st"])
})

test("search finds profiled buildings by their other names, and of several called the same, the nearest first", () => {
  const aliases = new Map<string, string[]>()
  for (const [alias, place] of searchNamesOf(MADE.data))
    aliases.set(place, [...aliases.get(place) ?? [], alias])
  const search = createPlaceSearch(places.map(({ name, at: [lon, lat] }) => ({ lat, lon, name })), CAMPUS, aliases)
  expect(search("Ham Smith")[0].name).toBe("Hamilton Smith Hall")
  expect(search("Dairy Bar")[0].name).toBe("Dairy Bar and Durham Train Station")
  const minis = search("The Minis").slice(0, 4)
  expect(minis.map(({ name }) => name).toSorted()).toEqual(["Eaton House", "Hall House", "Marston House", "Richardson House"])
  const far = minis.map(mini => distance(mini, CAMPUS))
  expect(far).toEqual(far.toSorted((a, b) => a - b))
})
