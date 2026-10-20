// The buildings laundry rooms and dining halls are in, as scripts/map/places.mts finds them in OpenStreetMap. The map
// shows them quietly, and the laundry and dining pages link to directions to them, like /map/?to=laundry/stoke-hall-g05

import * as v from "valibot"

/**
 * Every building, with a hash of the gazetteer, rooms, menus, and code they were derived from. A build keeps the file
 * while that hash still matches
 */
export const Places = v.object({ inputs: v.string(), buildings: v.array(v.lazy(() => Building)) })
export type Places = v.InferOutput<typeof Places>

export const Building = v.object({
  /** Like "laundry/stoke-hall" or "dining/holloway-commons" */
  id:    v.string(),
  kind:  v.picklist(["laundry", "dining"]),
  name:  v.string(),
  lat:   v.number(),
  lon:   v.number(),
  /** The slugs of a laundry building's rooms, as at /laundry/<slug>/ */
  rooms: v.optional(v.array(v.string()))
})
export type Building = v.InferOutput<typeof Building>

/** The building a link is to, by its own id or one of its laundry rooms', like "laundry/stoke-hall-g05" */
export const buildingAt = (buildings: readonly Building[], id: string) =>
  buildings.find(building =>
    building.id === id ||
    building.rooms?.some(room => `${building.kind}/${room}` === id)
  )
