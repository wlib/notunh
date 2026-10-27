// The itinerary drawn on the map while directions are shown: walks along the streets and paths, and rides along their
// route's shape. The camera fits it from directions alone (followPage in map.mts)

import { watch, type Reactive } from "bruh/reactive"
import type { GeoJSONSource, Map as MapLibre } from "maplibre-gl"
import type { Feed } from "../../transit/feed.mts"
import type { Itinerary } from "../../routing/plan.mts"
import type { LegPath } from "../state/trip.mts"
import type { Page } from "../link.mts"
import { collection, line } from "./layers.mts"

/** Draws the itinerary as its legs' paths have it, while directions are shown */
export const drawItinerary = (
  map: MapLibre,
  state: {
    page:      Reactive<Page | undefined>,
    feed:      Reactive<Feed>,
    itinerary: Reactive<Itinerary | undefined>,
    legPaths:  Reactive<LegPath[]>
  }
) => {
  // Walks follow the streets and paths, and rides the route's shape
  watch(() => {
    const itinerary = state.page.value?.kind === "directions" ? state.itinerary.value : undefined
    const paths = state.legPaths.value
    const source = map.getSource<GeoJSONSource>("itinerary")!

    if (!itinerary)
      return void source.setData(collection([]))

    source.setData(collection(itinerary.legs.map((leg, i) =>
      line(paths[i].coordinates, {
        kind: leg.kind,
        isEstimate: paths[i].via === "estimate",
        color: leg.kind === "ride" ? state.feed.value.routesById.get(leg.run.trip.route)?.color : undefined
      })
    )))
  })
}
