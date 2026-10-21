// Searching places by name, fuzzily as the dining page searches foods: stops, laundry and dining, and everything the
// gazetteer names, without asking anyone

import { type Point, distance } from "../geo/projection.mts"
import { fuzzySearch, latinize } from "../shared/fuzzy.mts"

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

/**
 * Searches some places, each name once. Of the places sharing a name, the one nearest `near` is kept, so a chain's
 * branch in town is found rather than its branch in the next
 */
export const createPlaceSearch = (places: readonly Place[], near: Point) => {
  const byName = new Map<string, Place>()
  for (const place of places) {
    const kept = byName.get(place.name)
    if (!kept || distance(place, near) < distance(kept, near))
      byName.set(place.name, place)
  }
  const unique = [...byName.values()]
  const names = latinize(unique.map(place => place.name))
  const lower = names.map(name => name.toLowerCase())

  /**
   * The places a search finds, best first, and one named exactly as searched before all. A better match comes first
   * unless another is much nearer or much more often chosen
   */
  return (query: string, { near: from = near, uses = () => 0 }: Ranking = {}): Place[] => {
    const needle = latinize(query.trim())
    if (!needle)
      return []
    const exact = needle.toLowerCase()
    const found = fuzzySearch(names, needle)
    const rank = (index: number, i: number) =>
      lower[index] === exact ? -Infinity
        : MATCH * i / found.length + PER_KM * distance(unique[index], from) / 1000 - PER_DOUBLE * Math.log2(1 + uses(unique[index]))
    return found
      .map(({ index }, i) => ({ index, rank: rank(index, i) }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, LIMIT)
      .map(({ index }) => unique[index])
  }
}
