// Searching places by name, fuzzily as the dining page searches foods: stops, laundry and dining, and everything the
// gazetteer names, without asking anyone

import { type Point, distance } from "../geo/projection.mts"
import { fuzzySearch, latinize } from "../shared/fuzzy.mts"

const LIMIT = 6

/** Somewhere to go from or to */
export type Place = {
  lat:  number,
  lon:  number,
  name: string,
  /** Where you are, moving with you */
  isYou?: true
}

/**
 * Searches some places, each name once: the first place by a name among those nearest `near` is the one found by it,
 * so a chain's branch in town is found before its branch in the next
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

  /** The places a search finds, best first, and one named exactly as searched before all */
  return (query: string): Place[] => {
    const needle = latinize(query.trim())
    if (!needle)
      return []
    const exact = needle.toLowerCase()
    return fuzzySearch(names, needle)
      .map(({ index }) => index)
      .sort((a, b) => Number(lower[b] === exact) - Number(lower[a] === exact))
      .slice(0, LIMIT)
      .map(index => unique[index])
  }
}
