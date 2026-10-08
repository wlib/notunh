// The buildings laundry rooms and dining halls are in, as scripts/map/places.mts finds them in OpenStreetMap, which
// the map shows quietly and the laundry and dining pages link to directions to, like /map/?to=laundry/stoke-hall-g05

import places from "./places.json"

export type Building = {
  /** Like "laundry/stoke-hall" or "dining/holloway-commons" */
  id:     string,
  kind:   "laundry" | "dining",
  name:   string,
  lat:    number,
  lon:    number,
  /** The slugs of a laundry building's rooms, as at /laundry/<slug>/ */
  rooms?: string[]
}

export const BUILDINGS = places as readonly Building[]

/** The building a link is to, by its own id or one of its laundry rooms', like "laundry/stoke-hall-g05" */
export const buildingAt = (id: string) =>
  BUILDINGS.find(building =>
    building.id === id ||
    building.rooms?.some(room => `${building.kind}/${room}` === id)
  )
