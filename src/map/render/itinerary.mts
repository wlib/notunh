// The itinerary drawn on the map: walks along the streets and paths, and rides along their route's shape, with the
// camera fitted to it whenever it goes another way

import { watch, type Reactive } from "bruh/reactive"
import type { GeoJSONSource, Map as MapLibre } from "maplibre-gl"
import type { Feed } from "../../transit/feed.mts"
import { type Itinerary, wayKey } from "../../routing/plan.mts"
import type { LegPath } from "../state/trip.mts"
import type { Show } from "./camera.mts"
import { collection, line } from "./layers.mts"

/** Draws the itinerary as its legs' paths have it, showing the whole of it when it's a new way */
export const drawItinerary = (
  map: MapLibre,
  state: {
    feed:      Reactive<Feed>,
    itinerary: Reactive<Itinerary | undefined>,
    legPaths:  Reactive<LegPath[]>
  },
  show: Show
) => {
  // Walks follow the streets and paths, and rides the route's shape
  let fitted: string | undefined
  watch(() => {
    const itinerary = state.itinerary.value
    const paths = state.legPaths.value
    const source = map.getSource<GeoJSONSource>("itinerary")!

    if (!itinerary) {
      source.setData(collection([]))
      fitted = undefined
      return
    }

    source.setData(collection(itinerary.legs.map((leg, i) =>
      line(paths[i].coordinates, {
        kind: leg.kind,
        isEstimate: paths[i].via === "estimate",
        color: leg.kind === "ride" ? state.feed.value.routesById.get(leg.run.trip.route)?.color : undefined
      })
    )))

    // Replanning with fresher times, or as you walk, redraws the same trip without moving the map
    const key = wayKey(itinerary)
    if (key !== fitted) {
      fitted = key
      const all = paths.flatMap(path => path.coordinates)
      const lons = all.map(([lon]) => lon)
      const lats = all.map(([, lat]) => lat)
      // maplibre fits bounds within the padding it was given and the map's own padding together, so the panel's
      // is set as the map's alone
      show(padding => {
        map.setPadding(padding)
        map.fitBounds(
          [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
          { maxZoom: 16.5 }
        )
      })
    }
  })
}
