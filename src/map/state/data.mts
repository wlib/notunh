// The map's bundled data, and what's derived from it: reactive values only, no DOM

import { r } from "bruh/reactive"
import { boardableStops, loadFeed } from "../../transit/feed.mts"
import { Model, emptyModel } from "../../transit/models/model.mts"
import { WalkData, loadGraph } from "../../routing/graph.mts"
import { createWalks } from "../../routing/walks.mts"
import { Places } from "../../places/buildings.mts"
import { Gazetteer } from "../../places/gazetteer.mts"
import { createPlaceSearch } from "../../places/search.mts"
import { loadStyle } from "../basemap/style.mts"
import { TilesManifest } from "../basemap/tiles.mts"
import { latest } from "../../shell/build.mts"

/** The middle of campus, which search prefers the nearer of two places by one name to */
const CAMPUS = { lat: 43.1365, lon: -70.9345 }

// The bundled data, each swapped for a newer build's as it comes, which everything derived from it follows. The
// map works without a model, so it starts with an empty one if its own can't load
export const [feed, model, network, gazetteerData, tiles, style, places] = await Promise.all([
  latest("gtfs", loadFeed),
  latest("model", Model, emptyModel),
  latest("walk", WalkData),
  latest("gazetteer", Gazetteer),
  latest("tiles", TilesManifest),
  latest("style", loadStyle),
  latest("places", Places)
])
const graph = r(() => loadGraph(network.value))
export const gazetteer = r(() => gazetteerData.value.places)
export const buildings = r(() => places.value.buildings)
export const walks = r(() => createWalks(feed.value.stops, graph.value, gazetteer.value))

/** Places by name, laundry and dining first, then the stops buses pick up at, then the rest of Durham */
export const searchPlaces = r(() => {
  const boardable = boardableStops(feed.value)
  return createPlaceSearch([
    ...buildings.value.map(({ lat, lon, name }) => ({ lat, lon, name })),
    ...feed.value.stops.filter((_, i) => boardable.has(i)).map(({ lat, lon, name }) => ({ lat, lon, name })),
    ...gazetteer.value.map(({ name, at: [lon, lat] }) => ({ lat, lon, name }))
  ], CAMPUS)
})
