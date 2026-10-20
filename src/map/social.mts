// The scene of the map's social image, which scripts/social.mts opens from the dev server rather than any page
// importing it: our style and tiles over central campus, pitched, with one route drawn by the map's own layers and its
// bus placed on it by hand rather than from Umo

import "maplibre-gl/dist/maplibre-gl.css"
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
import { Map as MapLibre, addProtocol, setWorkerUrl, type GeoJSONSource } from "maplibre-gl"
import { r } from "bruh/reactive"
import { loadFeed, routeLabel } from "../transit/feed.mts"
import { toLine, pointAt } from "../geo/lines.mts"
import { DRAWN_ICONS, glyphsFrom, hostedAt, loadStyle, upstreamGlyphs } from "./basemap/style.mts"
import { PROTOCOL, tileLoader } from "./basemap/tiles.mts"
import { DENSITY, poiIcon } from "./render/icons.mts"
import { addLayers, collection, drawLayers } from "./render/layers.mts"
import type { Places } from "../places/buildings.mts"

setWorkerUrl(workerUrl)

const query = new URLSearchParams(location.search)
const number = (name: string) => Number(query.get(name))

const [all, { style }, tiles, places] = await Promise.all([
  fetch("/src/map/gtfs.json").then(loadFeed),
  fetch("/src/map/style.json").then(response => loadStyle(response, {})),
  fetch("/src/map/tiles.json").then(response => response.json() as Promise<{ version?: string }>),
  fetch("/src/map/places.json").then(response => response.json() as Promise<Places>)
])

// The one route, with only its own stops, and the bus a share of the way along its first trip
const route = all.routesById.get(query.get("route")!)!
const trips = all.trips.filter(trip => trip.route === route.id)
const feed = { ...all, routes: [route], trips, stops: [...new Set(trips.flatMap(trip => trip.stops))].map(i => all.stops[i]) }

const line = toLine(all.shapes[trips[0].shape])
const { point, bearing } = pointAt(line, number("along") * line.length)

addProtocol(PROTOCOL, tileLoader(tiles.version))
const upstream = upstreamGlyphs(style)
const map = new MapLibre({
  container:          document.querySelector<HTMLElement>("#map")!,
  style:              hostedAt(style, location.origin),
  interactive:        false,
  attributionControl: false,
  fadeDuration:       0,
  transformRequest:   (url, type) => type === "Glyphs" ? { url: glyphsFrom(url, upstream) } : undefined
})
// Looking at a point of campus from where the card puts it
map.jumpTo({
  center:  [number("lon"), number("lat")],
  zoom:    number("zoom"),
  pitch:   number("pitch"),
  bearing: number("bearing"),
  padding: { left: number("left"), top: number("top"), right: 0, bottom: 0 }
})
map.on("styleimagemissing", ({ id }) => {
  if ((DRAWN_ICONS as readonly string[]).includes(id))
    map.addImage(id, poiIcon(id as typeof DRAWN_ICONS[number]), { pixelRatio: DENSITY })
})

map.on("load", () => {
  // Quieter than the app, as the route is all the card is about: no points of interest, and the buildings solid and
  // pale, like an architect's model, rather than see-through and grey
  for (const layer of ["poi_r1", "poi_r7", "poi_r20", "poi_transit"])
    map.setLayoutProperty(layer, "visibility", "none")
  map.setPaintProperty("building-3d", "fill-extrusion-color", "hsl(35, 12%, 91%)")
  map.setPaintProperty("building-3d", "fill-extrusion-opacity", 1)
  map.setLight({ intensity: 0.3 })
  addLayers(map)
  drawLayers(map, {
    feed:             r(feed),
    buildings:        r(places.buildings),
    shownRoutes:      r(new Set([route.id])),
    highlightedRoute: r(undefined),
    itinerary:        r(undefined)
  })
  // Larger than even a bus the app picks out, to be made out in a thumbnail
  map.getSource<GeoJSONSource>("vehicles")!.setData(collection([{
    type:       "Feature",
    properties: { route: route.id, label: routeLabel(route), text: route.text, bearing, scale: 1.6, opacity: 1 },
    geometry:   { type: "Point", coordinates: point }
  }]))
  map.once("idle", () => document.body.dataset.ready = "")
})
