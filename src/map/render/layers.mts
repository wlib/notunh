// The map's own sources and layers, drawn over the base map, and what fills them as the data changes: the routes in
// lanes side by side where they share a street, the stops, the laundry and dining buildings, the fraternities' and
// sororities' houses, today's events, and which routes and buses stand out

import { r, watch, type Reactive } from "bruh/reactive"
import type { GeoJSONSource, Map as MapLibre } from "maplibre-gl"
import type { Feed } from "../../transit/feed.mts"
import type { Itinerary } from "../../routing/plan.mts"
import type { Building } from "../../places/buildings.mts"
import type { GazetteerPlace } from "../../places/gazetteer.mts"
import { chapterNamed } from "../../places/chapters.mts"
import type { Placed } from "../state/today.mts"
import { clockOf } from "../../shared/time.mts"
import { groupBy } from "../../shared/group.mts"
import { isPractice } from "../../social/sport.mts"
import type { Coordinates } from "../../geo/projection.mts"
import { laneSlots, lanePieces, measureCorridors } from "./corridors.mts"
import { DENSITY, GREEK, QUIET, buildingIcon, busIcon, chapterIcon, chevronIcon } from "./icons.mts"

const FONT = ["Noto Sans Bold"]
// The page's ink, and the accent today's events are drawn in
const INK = "#23262e"
const EVENT = "#2f4f9e"

export const collection = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features
})

export const line = (coordinates: Coordinates[], properties: GeoJSON.GeoJsonProperties): GeoJSON.Feature => ({
  type: "Feature",
  properties,
  geometry: { type: "LineString", coordinates }
})

const ZOOMS = [12, 13.5, 15, 17]

/** Pixels across at each zoom, from low at zoom 12 to high at 17 */
const widthAt = (low: number, high: number) => (zoom: number) =>
  low + (high - low) * (zoom - 12) / 5

const byZoom = (f: (zoom: number) => any) =>
  ["interpolate", ["linear"], ["zoom"], ...ZOOMS.flatMap(zoom => [zoom, f(zoom)])] as any

const lineWidth = (low: number, high: number) =>
  byZoom(widthAt(low, high))

// Route lanes sit side by side, each a line width over
const LANE = widthAt(1.75, 4.5)
const CASING = widthAt(3.5, 7)
// Each piece of a lane is pushed over on screen by its slot, so lanes stay a line width apart at any zoom
const laneOffset = byZoom(zoom => ["*", ["get", "slot"], LANE(zoom)])

// Chevrons are scaled so a lane is this many of their icon pixels across. Their offset in icon pixels is then a fixed
// multiple of the slot
const CHEVRON_LANE = 3
const CHEVRON_SIZE = (zoom: number) => LANE(zoom) / CHEVRON_LANE

/** A color most of the way to white, faded without the overlapping ends of a lane's pieces showing through */
const fade = (color: string) =>
  "#" + [1, 3, 5].map(i => Math.round(255 - (255 - parseInt(color.slice(i, i + 2), 16)) * 0.15).toString(16).padStart(2, "0")).join("")

/** Chevrons along a line layer, showing which way its buses go */
const arrows = (id: string, source: string, filter?: any) => ({
  id,
  type: "symbol" as const,
  source,
  minzoom: 13.5,
  ...filter ? { filter } : {},
  layout: {
    "symbol-placement": "line" as const,
    "symbol-spacing": 120,
    "icon-image": ["concat", "chevron-", ["get", "route"]] as any,
    "icon-size": byZoom(CHEVRON_SIZE),
    // Icon pixels down are to the right of the line, where its lane is drawn
    "icon-offset": ["coalesce", ["get", "offset"], ["literal", [0, 0]]] as any,
    "icon-padding": 6,
    "icon-ignore-placement": true,
    "icon-rotation-alignment": "map" as const,
    "icon-keep-upright": false
  }
})

/** Each stop as a feature, by its index, which taps give back */
const stopFeatures = (feed: Feed) =>
  feed.stops.map((stop, i): GeoJSON.Feature => ({
    type: "Feature",
    id: i,
    properties: { name: stop.name },
    geometry: { type: "Point", coordinates: [stop.lon, stop.lat] }
  }))

/** Each route's shapes, for laying out the lanes routes share */
const corridorsOf = (feed: Feed) =>
  measureCorridors(feed.routes.flatMap(route =>
    [...new Set(feed.trips.filter(trip => trip.route === route.id).map(trip => trip.shape))]
      .map(shape => ({ route: route.id, coordinates: feed.shapes[shape] }))
  ))

/** Each laundry and dining building as a feature, by its index, which taps give back */
const buildingFeatures = (buildings: readonly Building[]) =>
  buildings.map(({ kind, name, lat, lon }, i): GeoJSON.Feature => ({
    type: "Feature",
    id: i,
    properties: { kind, name, color: QUIET[kind] },
    geometry: { type: "Point", coordinates: [lon, lat] }
  }))

/** Each fraternity's and sorority's house the gazetteer places as a feature, by its name, which taps give back */
export const chapterFeatures = (places: readonly GazetteerPlace[]) =>
  places.flatMap(({ name, at }): GeoJSON.Feature[] => {
    const chapter = chapterNamed(name)
    return chapter ? [{
      type: "Feature",
      properties: { name, kind: chapter.kind, letters: chapter.letters, color: GREEK[chapter.kind] },
      geometry: { type: "Point", coordinates: at }
    }] : []
  })

/**
 * A marker for each place with something on today, which a tap opens, labelled in words by what's on there now,
 * "Tennis · till 3:00 PM", filled, else by what's next, "Soccer · 3:00 PM", outlined. Today's list is soonest first,
 * so the first at a place still to end is the one it's labelled by, but for practices, which only label a place
 * that has nothing else on, drawn muted (src/social/sport.mts)
 */
export const eventFeatures = (placed: readonly Placed[], now: number) =>
  [...groupBy(placed.filter(({ event }) => event.end > now), ({ place }) => place.name).values()].map((here, i): GeoJSON.Feature => {
    const { event, place } = here.find(({ event }) => !isPractice(event)) ?? here[0]
    return {
      type: "Feature",
      id: i,
      properties: {
        place: place.name,
        on:    event.start <= now,
        muted: isPractice(event),
        label: event.start <= now ? `${event.title} · till ${clockOf(event.end)}` : `${event.title} · ${clockOf(event.start)}`
      },
      geometry: { type: "Point", coordinates: [place.lon, place.lat] }
    }
  })

/** Adds the map's own images, sources, and layers, all empty until drawn */
export const addLayers = (map: MapLibre) => {
  for (const kind of ["laundry", "dining"] as const)
    map.addImage(`building-${kind}`, buildingIcon(kind), { pixelRatio: DENSITY })
  for (const kind of ["fraternity", "sorority"] as const)
    map.addImage(`chapter-${kind}`, chapterIcon(kind), { pixelRatio: DENSITY })

  map.addSource("buildings", { type: "geojson", data: collection([]) })
  map.addSource("chapters",  { type: "geojson", data: collection([]) })
  map.addSource("events",    { type: "geojson", data: collection([]) })
  map.addSource("routes",    { type: "geojson", data: collection([]) })
  map.addSource("stops",     { type: "geojson", data: collection([]) })
  map.addSource("itinerary", { type: "geojson", data: collection([]) })
  map.addSource("vehicles",  { type: "geojson", data: collection([]) })

  const rounded = { "line-join": "round", "line-cap": "round" } as const
  const isRide = ["==", ["get", "kind"], "ride"] as any

  // Beneath everything of ours, faded in once the campus is close enough to tell buildings apart, and named
  // closer still, where there's room
  map.addLayer({
    id: "buildings",
    type: "symbol",
    source: "buildings",
    minzoom: 13.5,
    layout: {
      "icon-image": ["concat", "building-", ["get", "kind"]],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 13.5, 0.8, 17, 1],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "text-field": ["step", ["zoom"], "", 16.5, ["get", "name"]],
      "text-font": FONT,
      "text-size": 10,
      "text-offset": [0, 1.1],
      "text-anchor": "top",
      "text-max-width": 8,
      "text-optional": true
    },
    paint: {
      "icon-opacity": ["interpolate", ["linear"], ["zoom"], 13.5, 0, 14.5, 0.85],
      "text-color": ["get", "color"],
      "text-halo-color": "white",
      "text-halo-width": 1.25
    }
  })

  // The fraternities' and sororities' houses, as quiet as the buildings and faded in with them, labelled by their
  // letters once the houses are far enough apart to read. They take their place from the base map's labels, so a
  // house is named once, by its letters, rather than again by whatever OpenStreetMap calls it
  map.addLayer({
    id: "chapters",
    type: "symbol",
    source: "chapters",
    minzoom: 14,
    layout: {
      "icon-image": ["concat", "chapter-", ["get", "kind"]],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 14, 0.75, 17, 1],
      "icon-allow-overlap": true,
      "text-field": ["step", ["zoom"], "", 15.5, ["get", "letters"]],
      "text-font": FONT,
      "text-size": ["interpolate", ["linear"], ["zoom"], 15.5, 10, 18, 12],
      "text-offset": [0, 1.1],
      "text-anchor": "top",
      "text-optional": true
    },
    paint: {
      "icon-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, 0.9],
      "text-color": ["get", "color"],
      "text-halo-color": "white",
      "text-halo-width": 1.25
    }
  })

  // The places with something on today, filled while it's on and outlined till then, labelled once the campus is close
  map.addLayer({
    id: "events",
    type: "circle",
    source: "events",
    minzoom: 13,
    paint: {
      // A place with only practices on is smaller and fainter, there to say something's on but not to go to
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, ["case", ["get", "muted"], 3, 4], 17, ["case", ["get", "muted"], 6.5, 9]],
      "circle-color": ["case", ["get", "on"], EVENT, "white"],
      "circle-stroke-color": ["case", ["get", "on"], "white", EVENT],
      "circle-stroke-width": ["case", ["get", "muted"], 1.5, 2],
      "circle-opacity": ["case", ["get", "muted"], 0.75, 1],
      "circle-stroke-opacity": ["case", ["get", "muted"], 0.75, 1]
    }
  })
  map.addLayer({
    id: "event-labels",
    type: "symbol",
    source: "events",
    minzoom: 15.5,
    layout: {
      "text-field": ["get", "label"],
      "text-font": FONT,
      "text-size": ["case", ["get", "muted"], 10, 11],
      "text-offset": [0, 1],
      "text-anchor": "top",
      "text-max-width": 9,
      "text-optional": true
    },
    paint: {
      "text-color": EVENT,
      "text-halo-color": "white",
      "text-halo-width": 1.5,
      "text-opacity": ["case", ["get", "muted"], 0.6, 1]
    }
  })

  map.addLayer({
    id: "routes-casing",
    type: "line",
    source: "routes",
    layout: rounded,
    paint: { "line-color": "white", "line-width": byZoom(CASING), "line-offset": laneOffset }
  })
  map.addLayer({
    id: "routes",
    type: "line",
    source: "routes",
    layout: rounded,
    paint: { "line-color": ["get", "color"], "line-width": byZoom(LANE), "line-offset": laneOffset }
  })
  // Slide steps get no chevrons. They're too short to fit any, except overzoomed, where they'd crowd
  map.addLayer(arrows("routes-arrows", "routes", ["!", ["get", "isSliding"]]))

  map.addLayer({
    id: "itinerary-casing",
    type: "line",
    source: "itinerary",
    filter: isRide,
    layout: rounded,
    paint: { "line-color": "white", "line-width": lineWidth(6, 14) }
  })
  map.addLayer({
    id: "itinerary-ride",
    type: "line",
    source: "itinerary",
    filter: isRide,
    layout: rounded,
    paint: { "line-color": ["get", "color"], "line-width": lineWidth(4, 10) }
  })
  map.addLayer(arrows("itinerary-arrows", "itinerary", isRide))
  // A walk along the streets is dotted; one only estimated as a straight line, where the network doesn't join its
  // ends, is dashed and faint, as the guess it is
  map.addLayer({
    id: "itinerary-walk",
    type: "line",
    source: "itinerary",
    filter: ["==", ["get", "kind"], "walk"],
    layout: rounded,
    paint: {
      "line-color": INK,
      "line-width": lineWidth(2.5, 5),
      "line-dasharray": ["case", ["get", "isEstimate"], ["literal", [1.5, 1.5]], ["literal", [0.1, 2]]],
      "line-opacity": ["case", ["get", "isEstimate"], 0.5, 1]
    }
  })

  map.addLayer({
    id: "stops",
    type: "circle",
    source: "stops",
    minzoom: 12.5,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 12.5, 2.5, 17, 6],
      "circle-color": "white",
      "circle-stroke-color": INK,
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 12.5, 1, 17, 2]
    }
  })
  map.addLayer({
    id: "stop-labels",
    type: "symbol",
    source: "stops",
    minzoom: 16,
    layout: {
      "text-field": ["get", "name"],
      "text-font": FONT,
      "text-size": 11,
      "text-offset": [0, 1.1],
      "text-anchor": "top",
      "text-max-width": 9,
      "text-optional": true
    },
    paint: {
      "text-color": INK,
      "text-halo-color": "white",
      "text-halo-width": 1.5
    }
  })

  map.addLayer({
    id: "vehicles",
    type: "symbol",
    source: "vehicles",
    layout: {
      "icon-image": ["concat", "bus-", ["get", "route"]],
      "icon-rotate": ["get", "bearing"],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 11, ["*", 0.6, ["get", "scale"]], 16, ["*", 1, ["get", "scale"]]],
      "text-field": ["get", "label"],
      "text-font": FONT,
      "text-size": ["interpolate", ["linear"], ["zoom"], 11, 7, 16, 11],
      "text-offset": [0, 0.15],
      "text-allow-overlap": true
    },
    paint: {
      "text-color": ["get", "text"],
      "icon-opacity": ["get", "opacity"],
      "text-opacity": ["get", "opacity"]
    }
  })
}

/** Draws the routes, stops, buildings, chapters' houses, and today's events as the data has them, and which stand out */
export const drawLayers = (
  map: MapLibre,
  state: {
    feed:             Reactive<Feed>,
    buildings:        Reactive<readonly Building[]>,
    gazetteer:        Reactive<readonly GazetteerPlace[]>,
    todayPlaced:      Reactive<readonly Placed[]>,
    now:              Reactive<number>,
    shownRoutes:      Reactive<ReadonlySet<string>>,
    highlightedRoute: Reactive<string | undefined>,
    itinerary:        Reactive<Itinerary | undefined>
  }
) => {
  watch(() => {
    map.getSource<GeoJSONSource>("buildings")!.setData(collection(buildingFeatures(state.buildings.value)))
  })
  watch(() => {
    map.getSource<GeoJSONSource>("chapters")!.setData(collection(chapterFeatures(state.gazetteer.value)))
  })
  // Again each minute, as what's on at a place changes
  const minute = r(() => Math.floor(state.now.value / 60))
  watch([state.todayPlaced, minute], () => {
    map.getSource<GeoJSONSource>("events")!.setData(collection(eventFeatures(state.todayPlaced.value, minute.value * 60_000)))
  })

  // Each route's bus and chevrons in its color, and the stops, as the timetable has them
  watch(() => {
    for (const route of state.feed.value.routes)
      for (const [image, draw] of [[`bus-${route.id}`, busIcon], [`chevron-${route.id}`, chevronIcon]] as const)
        if (map.hasImage(image))
          map.updateImage(image, draw(route.color))
        else
          map.addImage(image, draw(route.color), { pixelRatio: DENSITY })
    map.getSource<GeoJSONSource>("stops")!.setData(collection(stopFeatures(state.feed.value)))
  })

  // Only the routes shown share lanes, so they're laid out again when that changes
  const corridors = r(() => corridorsOf(state.feed.value))
  const lanes = r(() => laneSlots(corridors.value, state.shownRoutes.value, state.feed.value.routes.map(route => route.id)))
  watch(() => {
    const colors = new Map(state.feed.value.routes.map(route => [route.id, route.color]))
    map.getSource<GeoJSONSource>("routes")!.setData(collection(
      lanePieces(lanes.value).map(({ route, slot, isSliding, coordinates }) => {
        const color = colors.get(route)!
        return line(coordinates, { route, slot, isSliding, color, faded: fade(color), offset: [0, slot * CHEVRON_LANE] })
      })
    ))
  })
  watch(() => {
    map.setFilter("vehicles", ["in", ["get", "route"], ["literal", [...state.shownRoutes.value]]])
  })

  // Routes fade behind an itinerary, and a highlighted one stands out: on top, wider, the rest faded
  watch(() => {
    const highlighted = state.highlightedRoute.value
    const isHighlighted = ["==", ["get", "route"], highlighted ?? ""] as any
    const dim = (bright: any, dimmed: any) =>
      state.itinerary.value ? dimmed :
      highlighted           ? ["case", isHighlighted, bright, dimmed] as any :
                              bright
    const opacity = (dimmed: number) => dim(1, dimmed)
    const wider = (width: (zoom: number) => number) =>
      byZoom(zoom => ["case", isHighlighted, width(zoom) * 1.6, width(zoom)])
    // Faded by color rather than opacity, as a lane's pieces overlap where they meet
    map.setPaintProperty("routes", "line-color", dim(["get", "color"], ["get", "faded"]))
    map.setPaintProperty("routes-arrows", "icon-opacity", opacity(0.15))
    map.setPaintProperty("routes-casing", "line-opacity", opacity(0.3))
    map.setPaintProperty("routes", "line-width", wider(LANE))
    map.setPaintProperty("routes-casing", "line-width", wider(CASING))
    for (const layer of ["routes-casing", "routes"])
      map.setLayoutProperty(layer, "line-sort-key", ["case", isHighlighted, 1, 0])
  })
}
