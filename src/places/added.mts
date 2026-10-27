// Places OpenStreetMap draws but doesn't name yet, named here so the map can search, place and walk to them as it
// does the gazetteer's. Each is the gazetteer's own shape, taken from the extract's outline of the building, and
// joins the gazetteer as it loads (Gazetteer in gazetteer.mts) unless a generation names it already, so one drawn
// and named upstream drops out here without a change

import type { GazetteerPlace } from "./gazetteer.mts"

export const ADDED: GazetteerPlace[] = [
  // UNH's Health Sciences Simulation Center, 25 Colovos Rd, "Health Services Science Center" (HSSC) in the
  // registrar's data (src/courses/buildings.mts), as the user confirmed. OpenStreetMap's way 1342295228, the one
  // unnamed building=university between Gregg Hall and Ritzman Lab off Waterworks Rd, where UNH says the center is
  // (unh.edu/unhtoday, tnhdigital.com), its outline and door as the extract of 20 Oct 2026 draws them
  {
    name:      "Health Sciences Simulation Center",
    kind:      "building",
    at:        [-70.93822, 43.13565],
    extent:    [-70.93853, 43.13528, -70.93784, 43.13603],
    outline:   [[[-70.93847, 43.1357], [-70.93853, 43.13549], [-70.93845, 43.13548], [-70.93842, 43.13548], [-70.93842, 43.13545], [-70.93836, 43.13544], [-70.9384, 43.13532], [-70.93815, 43.13528], [-70.93806, 43.13559], [-70.93819, 43.13561], [-70.93818, 43.13564], [-70.93817, 43.13567], [-70.93815, 43.13568], [-70.93816, 43.13569], [-70.93784, 43.1359], [-70.938, 43.13603], [-70.93833, 43.13581], [-70.93831, 43.1358], [-70.93832, 43.13579], [-70.93833, 43.13579], [-70.9384, 43.13575], [-70.93838, 43.13573], [-70.93838, 43.13572], [-70.93839, 43.13569]]],
    entrances: [[-70.93818, 43.13564]]
  }
]

/** Some places with the added ones a generation doesn't name yet, in the gazetteer's order by name */
export const withAdded = (places: readonly GazetteerPlace[]) => {
  const named = new Set(places.map(place => place.name))
  const missing = ADDED.filter(place => !named.has(place.name))
  return missing.length ? [...places, ...missing].sort((a, b) => a.name.localeCompare(b.name, "en")) : [...places]
}
