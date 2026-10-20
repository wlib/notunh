// A place as coarsely as usage stats name it (src/shell/events.mts), for counting where trips go without saying where
// anyone is. One of the places given by name, the map's buildings and bus stops, is named as it is. Anywhere else, like
// where you are, a point on the map, an address, or any other place found, is named by the nearest stop within a few
// minutes' walk, as stops are the coarsest places the map has, a block or so apart on campus and further in town.
// Further from any, it's "elsewhere"

import { type Point, distance } from "../geo/projection.mts"
import type { Place } from "./search.mts"

// About five minutes' walk
const NEAR_M = 400

export const coarseName = (place: Place, named: readonly Place[], stops: readonly Place[]) => {
  if (!place.isYou && named.some(({ name, lat, lon }) => name === place.name && lat === place.lat && lon === place.lon))
    return place.name
  const meters = (stop: Point) => distance(stop, place)
  const nearest = stops.reduce<Place | undefined>((best, stop) => !best || meters(stop) < meters(best) ? stop : best, undefined)
  return nearest && meters(nearest) <= NEAR_M ? nearest.name : "elsewhere"
}
