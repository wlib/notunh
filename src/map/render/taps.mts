// What a tap on the map is of, what the base map shows there to name it by, and the pins a trip's ends are dragged by

import { watch, type Reactive, type SourceNode } from "bruh/reactive"
import { Marker, type Map as MapLibre, type MapGeoJSONFeature } from "maplibre-gl"
import type { Place } from "../../places/search.mts"
import type { Page } from "../state/page.mts"
import { type GazetteerPlace, type MapHints, nameAt, placeAt } from "../../places/gazetteer.mts"
import type { Building } from "../../places/buildings.mts"
import { nearestOnLine, toLine } from "../../geo/lines.mts"
import { outlineHolds } from "../../geo/boxes.mts"
import type { Coordinates } from "../../geo/projection.mts"
import { BASE } from "../basemap/style.mts"

const TAP_RADIUS = 22 // px, about a fingertip

// The start and end of a trip
const START = "#2f8f5b"
const END = "#c8423b"
// Further than this from a house, a street isn't the one it's on
const MAX_STREET = 80 // m

/** A bus, a stop, a place the map knows by name, as its marker or outline, or a spot it doesn't */
export type Tap =
  | { kind: "bus",   id: string }
  | { kind: "stop",  stop: number }
  | { kind: "place", name: string }
  | { kind: "spot",  place: Place, hints: MapHints }

type Pixel = { x: number, y: number }

/** The rings of a polygon the map draws, as the gazetteer has outlines */
const ringsOf = (geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon) =>
  (geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat()) as Coordinates[][]

/** The nearest feature of a layer within a fingertip of a point */
const nearestWithin = (map: MapLibre, point: Pixel, layer: string) =>
  map.queryRenderedFeatures([[point.x - TAP_RADIUS, point.y - TAP_RADIUS], [point.x + TAP_RADIUS, point.y + TAP_RADIUS]], { layers: [layer] })
    .map(feature => {
      const { x, y } = map.project((feature.geometry as GeoJSON.Point).coordinates as Coordinates)
      return { feature, distance: Math.hypot(x - point.x, y - point.y) }
    })
    .filter(({ distance }) => distance <= TAP_RADIUS)
    .sort((a, b) => a.distance - b.distance)[0]?.feature

/** What the base map shows at a point, to name it */
const hintsAt = (map: MapLibre, point: Pixel): MapHints => {
  const layersOf = (sourceLayer: string) =>
    map.getStyle().layers
      .filter(layer => "source-layer" in layer && layer["source-layer"] === sourceLayer)
      .map(layer => layer.id)
  const named = (features: MapGeoJSONFeature[]) =>
    features.find(feature => feature.properties.name)?.properties.name as string | undefined
  const outline = map.queryRenderedFeatures([point.x, point.y], { layers: layersOf("building") })
    .map(feature => feature.geometry)
    .find((geometry): geometry is GeoJSON.Polygon | GeoJSON.MultiPolygon =>
      geometry.type === "Polygon" || geometry.type === "MultiPolygon"
    )
  const rings = outline && ringsOf(outline)

  return {
    label: named(map.queryRenderedFeatures([[point.x - 8, point.y - 8], [point.x + 8, point.y + 8]], { layers: layersOf("poi") })),
    outline: rings,
    address: rings && addressIn(map, rings)
  }
}

/**
 * The address of a building, from the house number the tiles have within its outline, and the street nearest that,
 * as the tiles don't say which street it's on
 */
const addressIn = (map: MapLibre, rings: Coordinates[][]) => {
  const house = map.querySourceFeatures(BASE, { sourceLayer: "housenumber" })
    .find(({ geometry }) => geometry.type === "Point" && outlineHolds(rings, { lon: geometry.coordinates[0], lat: geometry.coordinates[1] }))
  if (!house)
    return undefined
  const [lon, lat] = (house.geometry as GeoJSON.Point).coordinates
  const street = map.querySourceFeatures(BASE, { sourceLayer: "transportation_name" })
    .filter(({ properties }) => properties.name && properties.class !== "path")
    .flatMap(({ geometry, properties }) =>
      (geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : [])
        .map(line => ({ name: properties.name as string, meters: nearestOnLine(toLine(line as Coordinates[]), { lat, lon }).meters }))
    )
    .filter(({ meters }) => meters <= MAX_STREET)
    .sort((a, b) => a.meters - b.meters)[0]
  return street && `${house.properties.housenumber} ${street.name}`
}

/**
 * A pin at each end of the trip, dropped elsewhere by dragging it, and named for where it's dropped. An end that's
 * you has your dot instead, as a pin would only catch up with you every so often
 */
export const dropPins = (map: MapLibre, state: { page: Reactive<Page | undefined>, from: SourceNode<Place | undefined>, to: SourceNode<Place | undefined>, gazetteer: Reactive<readonly GazetteerPlace[]> }) => {
  for (const [color, place] of [[START, state.from], [END, state.to]] as const) {
    const marker = new Marker({ color, draggable: true })
    marker.on("dragend", async () => {
      const { lng, lat } = marker.getLngLat()
      const dropped = { lon: lng, lat, name: "Dropped pin" }
      place.value = dropped
      const name = await nameAt(state.gazetteer.peek(), dropped, hintsAt(map, map.project([lng, lat])))
      if (name && place.peek() === dropped)
        place.value = { ...dropped, name }
    })
    // Only while directions are shown: the trip is kept for Back to return to, but its ends aren't marked elsewhere
    watch(() => {
      if (state.page.value?.kind === "directions" && place.value && !place.value.isYou)
        marker.setLngLat([place.value.lon, place.value.lat]).addTo(map)
      else
        marker.remove()
    })
  }
}

/**
 * Says what each tap is of: buses first, then stops, then the places with something on today, then laundry and
 * dining, then a building the gazetteer names by its outline, else the spot itself
 */
export const listenForTaps = (map: MapLibre, state: { buildings: Reactive<readonly Building[]>, gazetteer: Reactive<readonly GazetteerPlace[]> }, onTap: (tap: Tap) => void) => {
  map.on("mousemove", event => {
    const isTappable = ["vehicles", "stops", "events", "buildings"].some(layer => nearestWithin(map, event.point, layer))
    map.getCanvas().style.cursor = isTappable ? "pointer" : ""
  })

  map.on("click", event => {
    const bus = nearestWithin(map, event.point, "vehicles")
    if (bus)
      return onTap({ kind: "bus", id: bus.properties.id })

    const stop = nearestWithin(map, event.point, "stops")
    if (stop)
      return onTap({ kind: "stop", stop: stop.id as number })

    const marked = nearestWithin(map, event.point, "events")
    if (marked)
      return onTap({ kind: "place", name: marked.properties.place })

    const building = nearestWithin(map, event.point, "buildings")
    if (building && state.buildings.peek()[building.id as number])
      return onTap({ kind: "place", name: state.buildings.peek()[building.id as number].name })

    const { lng, lat } = event.lngLat
    const hints = hintsAt(map, event.point)
    // A building whose middle is in the outline tapped, as the gazetteer names it
    const outlined = hints.outline && placeAt(state.gazetteer.peek(), { lon: lng, lat }, hints.outline)
    if (outlined?.kind === "building" && outlineHolds(hints.outline!, { lon: outlined.at[0], lat: outlined.at[1] }))
      return onTap({ kind: "place", name: outlined.name })
    onTap({ kind: "spot", place: { lon: lng, lat, name: "Dropped pin" }, hints })
  })
}
