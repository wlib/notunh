import "maplibre-gl/dist/maplibre-gl.css"
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
import { Map as MapLibre, AttributionControl, NavigationControl, Marker, addProtocol, setWorkerUrl, type GeoJSONSource, type MapGeoJSONFeature } from "maplibre-gl"
import { r, watch, type Reactive, type SourceNode } from "bruh/reactive"
import type { StyleSpecification } from "maplibre-gl"
import type { Feed } from "./feed.mts"
import type { Followed } from "./tracking.mts"
import { type Itinerary, type Place, wayKey } from "./plan.mts"
import type { LegPath } from "./state.mts"
import { nearestOnLine, toLine } from "../geo/lines.mts"
import { outlineHolds } from "../geo/boxes.mts"
import type { Coordinates } from "../geo/projection.mts"
import { type Padding, coveredPadding } from "./camera.mts"
import { type GazetteerPlace, type MapHints, nameAt } from "./gazetteer.mts"
import { animateBuses } from "./buses.mts"
import { showYou } from "./you.mts"
import type { Building } from "./places.mts"
import { laneSlots, lanePieces, measureCorridors } from "./corridors.mts"
import { BASE, DRAWN_ICONS, type LoadedStyle, glyphsFrom, hostedAt, upstreamGlyphs } from "./style.mts"
import { PROTOCOL, tileLoader } from "./tiles.mts"

// maplibre finds its worker with a computed URL that vite can't see, so bundle it as a worker explicitly
setWorkerUrl(workerUrl)

const FONT = ["Noto Sans Bold"]
const DURHAM: Coordinates = [-70.9345, 43.1365]
const TAP_RADIUS = 22 // px, about a fingertip
const SETTLE_MS = 1000 // the panel's size settles this soon after it changes what it shows

// The page's ink, and the start and end of a trip
const INK = "#23262e"
const START = "#2f8f5b"
const END = "#c8423b"
// Laundry and dining buildings, muted to sit quietly beneath the buses
const QUIET: Record<Building["kind"], string> = { laundry: "#71839b", dining: "#a1825c" }
// Further than this from a house, a street isn't the one it's on
const MAX_STREET = 80 // m

export type Tap =
  | { kind: "bus",      id: string }
  | { kind: "stop",     stop: number }
  | { kind: "building", place: Place }
  | { kind: "place",    place: Place, hints: MapHints }

// Bitmaps drawn at the screen's own density, and at least twice their size, so they're sharp wherever they're shown
const DENSITY = Math.max(2, Math.ceil(devicePixelRatio))
const icon = (size: number, draw: (context: OffscreenCanvasRenderingContext2D) => void) => {
  const canvas = new OffscreenCanvas(size * DENSITY, size * DENSITY)
  const context = canvas.getContext("2d")!
  context.scale(DENSITY, DENSITY)
  draw(context)
  return {
    width:  size * DENSITY,
    height: size * DENSITY,
    data: new Uint8Array(context.getImageData(0, 0, size * DENSITY, size * DENSITY).data.buffer)
  }
}

// A circle drawn to a point toward the bearing (north, before rotation), its sides tangent to the circle
const busIcon = (color: string) =>
  icon(40, context => {
    const [x, y, radius, tip] = [20, 22, 12, 3]
    // The angle either side of straight up where a line from the tip just touches the circle
    const touch = Math.acos(radius / (y - tip))
    context.beginPath()
    context.moveTo(x, tip)
    context.arc(x, y, radius, -Math.PI / 2 + touch, -Math.PI / 2 - touch + 2 * Math.PI)
    context.closePath()
    context.lineJoin = "round"
    context.fillStyle = color
    context.strokeStyle = "white"
    context.lineWidth = 2.5
    context.shadowColor = "rgb(0 0 0 / 0.35)"
    context.shadowBlur = 4
    context.fill()
    context.shadowBlur = 0
    context.stroke()
  })

// Pointing along the line (east, before maplibre aligns it): a pale tint of the line, edged in white
const chevronIcon = (color: string) =>
  icon(12, context => {
    context.beginPath()
    context.moveTo(3.5, 2)
    context.lineTo(7.5, 6)
    context.lineTo(3.5, 10)
    context.lineCap = "round"
    context.lineJoin = "round"
    context.strokeStyle = "white"
    context.lineWidth = 4
    context.stroke()
    context.strokeStyle = color
    context.lineWidth = 2
    context.stroke()
    // White over it, part way, tints it
    context.globalAlpha = 0.45
    context.strokeStyle = "white"
    context.stroke()
  })

// Glyphs on a 24 unit grid, after Tabler's wash machine, tools kitchen 2, and recycle, pared down to read at a dozen
// pixels
const GLYPHS: Record<Building["kind"] | typeof DRAWN_ICONS[number], string> = {
  laundry:         "M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2z M16 14a4 4 0 1 1 -8 0a4 4 0 1 1 8 0 M8.5 6.5h.01 M11.5 6.5h.01",
  dining:          "M19 3v12h-5c-.02 -3.68 .18 -7.4 5 -12z M19 15v6 M8 3v18 M5 3v3a3 3 0 0 0 6 0v-3",
  bicycle_parking: "M9.5 15.5a3.5 3.5 0 1 1 -7 0a3.5 3.5 0 1 1 7 0 M21.5 15.5a3.5 3.5 0 1 1 -7 0a3.5 3.5 0 1 1 7 0 M6 15.5l4 -7h6.5l1.5 7 M6 15.5h6l4.5 -7 M10 8.5l2 7 M8.5 6.5h3 M16.5 8.5l-.75 -2.5h2",
  atm:             "M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z M3 10h18 M7 15h3",
  recycling:       "M12 17l-2 2l2 2 M10 19h9a2 2 0 0 0 1.75 -2.75l-.55 -1 M8.536 11l-.732 -2.732l-2.732 .732 M7.804 8.268l-4.5 7.794a2 2 0 0 0 1.506 2.89l1.141 .024 M15.464 11l2.732 .732l.732 -2.732 M18.196 11.732l-4.5 -7.794a2 2 0 0 0 -3.256 -.14l-.591 .976"
}

type Disc = {
  ring:      string,
  disc:      string,
  ink:       string,
  ringWidth: number,
  // The glyph's size as a part of its 24 unit grid, and its strokes' width in those units
  scale:     number,
  weight:    number,
  shadow?:   boolean
}

/** A glyph in a disc, inside a ring of another color, and maybe a shadow */
const discIcon = (size: number, glyph: keyof typeof GLYPHS, { ring, disc, ink, ringWidth, scale, weight, shadow = false }: Disc) =>
  icon(size, context => {
    const middle = size / 2
    context.beginPath()
    context.arc(middle, middle, middle - 1, 0, 2 * Math.PI)
    context.fillStyle = ring
    if (shadow) {
      context.shadowColor = "rgb(0 0 0 / 0.2)"
      context.shadowBlur = 1.5
    }
    context.fill()
    context.shadowColor = "transparent"
    context.beginPath()
    context.arc(middle, middle, middle - 1 - ringWidth, 0, 2 * Math.PI)
    context.fillStyle = disc
    context.fill()
    context.translate(middle, middle)
    context.scale(scale, scale)
    context.translate(-12, -12)
    context.strokeStyle = ink
    context.lineWidth = weight
    context.lineCap = "round"
    context.lineJoin = "round"
    context.stroke(new Path2D(GLYPHS[glyph]))
  })

// A small muted disc in a white ring, with its glyph in white: a washing machine for laundry, a fork and knife
// for dining
const buildingIcon = (kind: Building["kind"]) =>
  discIcon(20, kind, { ring: "white", disc: QUIET[kind], ink: "white", ringWidth: 1.25, scale: 0.45, weight: 2.25, shadow: true })

// As Liberty's sprite draws points of interest, a colored glyph in a white disc ringed in grey, but for bicycle
// parking, which is white on parking's blue
const POI_ICON = { ring: "#bbb", disc: "white", ringWidth: 1, scale: 0.55, weight: 2.25 }
const poiIcon = (name: typeof DRAWN_ICONS[number]) =>
  discIcon(21, name, {
    bicycle_parking: { ...POI_ICON, ring: "white", disc: "#4898ff", ink: "white" },
    atm:             { ...POI_ICON, ink: "#5d60be" },
    recycling:       { ...POI_ICON, ink: "#76a723" }
  }[name])

const collection = (features: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features
})

const line = (coordinates: Coordinates[], properties: GeoJSON.GeoJsonProperties): GeoJSON.Feature => ({
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

// Chevrons scaled with lanes, a lane being this many of their pixels across, so they're pushed over by a fixed
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

/** The rings of a polygon the map draws, as the gazetteer has outlines */
const ringsOf = (geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon) =>
  (geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat()) as Coordinates[][]

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

/**
 * Draws the map, following the data as newer builds swap it in: the timetable's stops and routes, the model the
 * buses are driven by, the gazetteer taps are named from, the laundry and dining buildings, and which week's tiles
 * are ours
 */
export const createMap = (
  container: HTMLElement,
  panel: HTMLElement,
  state: {
    feed:             Reactive<Feed>,
    gazetteer:        Reactive<readonly GazetteerPlace[]>,
    buildings:        Reactive<readonly Building[]>,
    tiles:            Reactive<{ version?: string }>,
    style:            Reactive<LoadedStyle>,
    followed:         Reactive<ReadonlyMap<string, Followed>>,
    layovers:         Reactive<ReadonlySet<string>>,
    shownRoutes:      Reactive<ReadonlySet<string>>,
    highlightedRoute: Reactive<string | undefined>,
    from:             SourceNode<Place | undefined>,
    to:               SourceNode<Place | undefined>,
    selectedStopId:   Reactive<string | undefined>,
    itinerary:        Reactive<Itinerary | undefined>,
    legPaths:         Reactive<LegPath[]>,
    focusedBuses:     Reactive<{ vehicles?: ReadonlySet<string>, route?: string }>,
    riding:           Reactive<string | undefined>
  },
  onTap: (tap: Tap) => void
) => {
  // The style's tiles, ours where we have them, from the folder of the week the data names
  let version = state.tiles.peek().version
  addProtocol(PROTOCOL, tileLoader(version))
  // Glyphs outside the ranges kept with our style come from where it says
  let upstream: string | undefined
  const map = new MapLibre({
    container,
    center: DURHAM,
    zoom: 14.5,
    attributionControl: false,
    transformRequest: (url, type) => type === "Glyphs" ? { url: glyphsFrom(url, upstream) } : undefined
  })
  // Our style as loaded, keeping what the map added to the one before: the sources and layers that aren't the style's
  const transformStyle = (previous: StyleSpecification | undefined, style: StyleSpecification) => {
    upstream = upstreamGlyphs(style)
    const ours = Object.entries(previous?.sources ?? {}).filter(([id]) => !(id in style.sources))
    return hostedAt({
      ...style,
      sources: { ...style.sources, ...Object.fromEntries(ours) },
      layers: [...style.layers, ...previous?.layers.filter(layer => "source" in layer && ours.some(([id]) => id === layer.source)) ?? []]
    }, location.origin)
  }
  // A newer build's style comes in as the differences from the one showing, so nothing flickers. It's loaded with
  // its manifest, so what's applied is always what's had
  let styleUrl: string | undefined
  watch([state.style], () => {
    const { url, style } = state.style.value
    if (url === styleUrl)
      return
    styleUrl = url
    map.setStyle(style, { transformStyle })
  })
  // The points of interest Liberty's sprite has no icon for, drawn as they're needed
  map.on("styleimagemissing", ({ id }) => {
    if ((DRAWN_ICONS as readonly string[]).includes(id))
      map.addImage(id, poiIcon(id as typeof DRAWN_ICONS[number]), { pixelRatio: DENSITY })
  })
  // A newer week's tiles are loaded afresh, each showing in place of the one before it as it comes
  watch([state.tiles], () => {
    if (state.tiles.value.version === version)
      return
    version = state.tiles.value.version
    addProtocol(PROTOCOL, tileLoader(version))
    for (const [id, source] of Object.entries(map.getStyle()?.sources ?? {}))
      if ("tiles" in source && source.tiles?.some(tile => tile.startsWith(`${PROTOCOL}://`)))
        map.refreshTiles(id)
  })
  map.addControl(new AttributionControl({ compact: true }), "bottom-right")
  map.addControl(new NavigationControl({ visualizePitch: true }), "top-right")
  // Buses are only drawn once the map has loaded, but the location button is wanted right away
  let busPosition: (id: string) => Coordinates | undefined = () => undefined
  const drawYou = showYou(map, panel, state.riding, id => busPosition(id))

  // What the camera should show, kept clear of the panel and reapplied while the panel settles into its
  // new size, then left alone; touching the map lets go of it right away
  let intent: ((padding: Padding) => void) | undefined
  let settled: ReturnType<typeof setTimeout> | undefined
  const frame = () =>
    intent?.(coveredPadding(container.getBoundingClientRect(), panel.getBoundingClientRect()))
  const show = (next: typeof intent) => {
    intent = next
    clearTimeout(settled)
    settled = setTimeout(() => intent = undefined, SETTLE_MS)
    // After this flush's DOM updates, so the panel has its new size
    queueMicrotask(frame)
  }
  new ResizeObserver(frame).observe(panel)
  for (const type of ["pointerdown", "wheel", "keydown"])
    container.addEventListener(type, () => intent = undefined, { capture: true, passive: true })
  show(padding => map.jumpTo({ center: DURHAM, padding }))

  for (const [color, place] of [[START, state.from], [END, state.to]] as const) {
    const marker = new Marker({ color, draggable: true })
    marker.on("dragend", async () => {
      const { lng, lat } = marker.getLngLat()
      const dropped = { lon: lng, lat, name: "Dropped pin" }
      place.value = dropped
      const name = await nameAt(state.gazetteer.peek(), dropped, hintsAt(map.project([lng, lat])))
      if (name && place.peek() === dropped)
        place.value = { ...dropped, name }
    })
    watch(() => {
      if (place.value)
        marker.setLngLat([place.value.lon, place.value.lat]).addTo(map)
      else
        marker.remove()
    })
  }

  // The nearest feature of a layer within a fingertip of a point
  const nearestWithin = (point: { x: number, y: number }, layer: string) =>
    map.queryRenderedFeatures([[point.x - TAP_RADIUS, point.y - TAP_RADIUS], [point.x + TAP_RADIUS, point.y + TAP_RADIUS]], { layers: [layer] })
      .map(feature => {
        const { x, y } = map.project((feature.geometry as GeoJSON.Point).coordinates as Coordinates)
        return { feature, distance: Math.hypot(x - point.x, y - point.y) }
      })
      .filter(({ distance }) => distance <= TAP_RADIUS)
      .sort((a, b) => a.distance - b.distance)[0]?.feature

  // What the base map shows at a point, to name it
  const hintsAt = (point: { x: number, y: number }): MapHints => {
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
      address: rings && addressIn(rings)
    }
  }

  // The address of a building, from the house number the tiles have within its outline, and the street nearest that,
  // as the tiles don't say which street it's on
  const addressIn = (rings: Coordinates[][]) => {
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

  map.on("load", () => {
    for (const kind of ["laundry", "dining"] as const)
      map.addImage(`building-${kind}`, buildingIcon(kind), { pixelRatio: DENSITY })

    map.addSource("buildings", { type: "geojson", data: collection([]) })
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
    // A slide's steps are too short for chevrons, except overzoomed, where they'd crowd
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

    map.on("mousemove", event => {
      const isTappable = ["vehicles", "stops", "buildings"].some(layer => nearestWithin(event.point, layer))
      map.getCanvas().style.cursor = isTappable ? "pointer" : ""
    })

    // Buses first, then stops, then laundry and dining, else the spot itself
    map.on("click", event => {
      const bus = nearestWithin(event.point, "vehicles")
      if (bus)
        return onTap({ kind: "bus", id: bus.properties.id })

      const stop = nearestWithin(event.point, "stops")
      if (stop)
        return onTap({ kind: "stop", stop: stop.id as number })

      const building = nearestWithin(event.point, "buildings")
      if (building) {
        const { lat, lon, name } = state.buildings.peek()[building.id as number]
        return onTap({ kind: "building", place: { lat, lon, name } })
      }

      const { lng, lat } = event.lngLat
      onTap({ kind: "place", place: { lon: lng, lat, name: "Dropped pin" }, hints: hintsAt(event.point) })
    })

    watch(() => {
      map.getSource<GeoJSONSource>("buildings")!.setData(collection(buildingFeatures(state.buildings.value)))
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

    // Once for each stop selected, and not again as a newer timetable renumbers it
    watch([state.selectedStopId], () => {
      const stop = state.feed.peek().stops.find(stop => stop.id === state.selectedStopId.value)
      if (!stop)
        return
      const zoom = Math.max(map.getZoom(), 16)
      show(padding => map.easeTo({ center: [stop.lon, stop.lat], zoom, padding }))
    })

    busPosition = animateBuses(map, state.feed, state.followed, state.layovers, state.focusedBuses)
    drawYou()
  })

  return { map }
}
