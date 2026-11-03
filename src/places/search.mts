// Searching places by name, fuzzily as the dining page searches foods: stops, laundry and dining, and everything the
// gazetteer names, without asking anyone. A place may go by other names too, its aliases, as a fraternity's house by
// its letters and nicknames, and is found by any of them as by its name

import { type Point, distance } from "../geo/projection.mts"
import { fuzzySearch, latinize, spellGreek } from "../shared/fuzzy.mts"

const LIMIT      = 6
// A match ranks by how far down uFuzzy's order it is, from 0 for the best to MATCH for the worst, as its order among
// many alike, like every place named "… Hall", says little. Nearer and more often chosen places then rise above it
const MATCH      = 10
const PER_KM     = 1 // for each km farther away
const PER_DOUBLE = 5 // for each doubling of the times it's been chosen

/** Somewhere to go from or to */
export type Place = {
  lat:  number,
  lon:  number,
  name: string,
  /** Where you are, moving with you */
  isYou?: true
}

/** What a search ranks matches by beyond how well they match: how near `near` they are, and how often they've been chosen */
export type Ranking = { near?: Point, uses?: (place: Place) => number }

/** Text as a search compares it: Greek letters spelled out, as "ΣΦΕ" is "Sigma Phi Epsilon", and without accents */
const searchable = (text: string) =>
  latinize(spellGreek(text))

/** Text as an exact match compares it: case, spaces and punctuation aside, so "t hall", "T-Hall" and "THall" are one */
const keyOf = (text: string) =>
  searchable(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")

/**
 * Searches things by their names, each by any of its own: every thing found, once, best first, and whether one of its
 * names is just what's searched, case, spaces and punctuation aside. Those named just so come first, found whether or
 * not the fuzzy search finds them, as it may not for a short name like "MUB" among longer ones
 */
export const createNameSearch = (namesOf: readonly (readonly string[])[]) => {
  const rows = namesOf.flatMap((names, index) => names.map(name => ({ index, name: searchable(name) })))
  const names = rows.map(({ name }) => name)
  const byKey = new Map<string, Set<number>>()
  for (const { index, name } of rows)
    byKey.set(keyOf(name), (byKey.get(keyOf(name)) ?? new Set()).add(index))
  return (query: string) => {
    const needle = searchable(query.trim())
    if (!needle)
      return []
    const found = new Map<number, boolean>([...byKey.get(keyOf(needle)) ?? []].map(index => [index, true]))
    for (const { index: row } of fuzzySearch(names, needle))
      if (!found.has(rows[row].index))
        found.set(rows[row].index, false)
    return [...found].map(([index, isExact]) => ({ index, isExact }))
  }
}

/**
 * Searches some places, each name once, and each by its aliases, by its name. Of the places sharing a name, the one
 * nearest `near` is kept, so a chain's branch in town is found rather than its branch in the next
 */
export const createPlaceSearch = (places: readonly Place[], near: Point, aliases: ReadonlyMap<string, readonly string[]> = new Map()) => {
  const byName = new Map<string, Place>()
  for (const place of places) {
    const kept = byName.get(place.name)
    if (!kept || distance(place, near) < distance(kept, near))
      byName.set(place.name, place)
  }
  const unique = [...byName.values()]
  const search = createNameSearch(unique.map(({ name }) => [name, ...aliases.get(name) ?? []]))

  /**
   * The places a search finds, best first, and one named exactly as searched, by its name or an alias, before all. A
   * better match comes first unless another is much nearer or much more often chosen
   */
  return (query: string, { near: from = near, uses = () => 0 }: Ranking = {}): Place[] => {
    const found = search(query)
    const rank = (index: number, isExact: boolean, i: number) =>
      isExact ? -Infinity
        : MATCH * i / found.length + PER_KM * distance(unique[index], from) / 1000 - PER_DOUBLE * Math.log2(1 + uses(unique[index]))
    return found
      .map(({ index, isExact }, i) => ({ index, rank: rank(index, isExact, i) }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, LIMIT)
      .map(({ index }) => unique[index])
  }
}
