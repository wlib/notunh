import "maplibre-gl/dist/maplibre-gl.css"
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
import { Map as MapLibre, AttributionControl, NavigationControl, Marker, setWorkerUrl, type GeoJSONSource, type MapGeoJSONFeature } from "maplibre-gl"
import { r, watch, type Reactive, type SourceNode } from "bruh/reactive"
import type { Feed } from "./feed.mts"
import type { Vehicle } from "./umo.mts"
import type { Itinerary, Place } from "./plan.mts"
import { type Coordinates, type Padding, coveredPadding, ridePath } from "./geometry.mts"
import { nameAt, walkPath, type MapHints } from "./osm.mts"
import { animateBuses } from "./buses.mts"
import { showYou } from "./you.mts"
import { laneSlots, lanePieces, measureCorridors } from "./corridors.mts"

// maplibre finds its worker with a computed URL that vite can't see, so bundle it as a worker explicitly
setWorkerUrl(workerUrl)

const STYLE = "https://tiles.openfreemap.org/styles/liberty"
const FONT = ["Noto Sans Bold"]
const DURHAM: Coordinates = [-70.9345, 43.1365]
const TAP_RADIUS = 22 // px, about a fingertip
const SETTLE_MS = 1000 // the panel's size settles this soon after it changes what it shows

// The page's ink, and the start and end of a trip
const INK = "#23262e"
const START = "#2f8f5b"
const END = "#c8423b"

export type Tap =
  | { kind: "bus",   id: string }
  | { kind: "stop",  stop: number }
  | { kind: "place", place: Place, hints: MapHints }

// Bitmaps drawn at twice their size for sharp screens
const icon = (size: number, draw: (context: OffscreenCanvasRenderingContext2D) => void) => {
  const canvas = new OffscreenCanvas(size * 2, size * 2)
  const context = canvas.getContext("2d")!
  context.scale(2, 2)
  draw(context)
  return {
    width:  size * 2,
    height: size * 2,
    data: new Uint8Array(context.getImageData(0, 0, size * 2, size * 2).data.buffer)
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

export const createMap = (
  container: HTMLElement,
  panel: HTMLElement,
  feed: Feed,
  state: {
    vehicles:         Reactive<Vehicle[]>,
    layovers:         Reactive<ReadonlySet<string>>,
    shownRoutes:      Reactive<ReadonlySet<string>>,
    highlightedRoute: Reactive<string | undefined>,
    from:             SourceNode<Place | undefined>,
    to:               SourceNode<Place | undefined>,
    selectedStop:     SourceNode<number | undefined>,
    itinerary:        Reactive<Itinerary | undefined>,
    focusedBuses:     Reactive<{ vehicles?: ReadonlySet<string>, route?: string }>,
    riding:           Reactive<string | undefined>
  },
  onTap: (tap: Tap) => void
) => {
  const map = new MapLibre({
    container,
    style: STYLE,
    center: DURHAM,
    zoom: 14.5,
    attributionControl: false
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

  const corridors = measureCorridors(feed.routes.flatMap(route =>
    [...new Set(feed.trips.filter(trip => trip.route === route.id).map(trip => trip.shape))]
      .map(shape => ({ route: route.id, coordinates: feed.shapes[shape] }))
  ))
  const routeOrder = feed.routes.map(route => route.id)

  const stopFeatures = feed.stops.map((stop, i): GeoJSON.Feature => ({
    type: "Feature",
    id: i,
    properties: { name: stop.name },
    geometry: { type: "Point", coordinates: [stop.lon, stop.lat] }
  }))

  for (const [color, place] of [[START, state.from], [END, state.to]] as const) {
    const marker = new Marker({ color, draggable: true })
    marker.on("dragend", async () => {
      const { lng, lat } = marker.getLngLat()
      const dropped = { lon: lng, lat, name: "Dropped pin" }
      place.value = dropped
      const name = await nameAt(dropped)
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

    return {
      label: named(map.queryRenderedFeatures([[point.x - 8, point.y - 8], [point.x + 8, point.y + 8]], { layers: layersOf("poi") })),
      outline: map.queryRenderedFeatures([point.x, point.y], { layers: layersOf("building") })
        .map(feature => feature.geometry)
        .find((geometry): geometry is GeoJSON.Polygon | GeoJSON.MultiPolygon =>
          geometry.type === "Polygon" || geometry.type === "MultiPolygon"
        )
    }
  }

  map.on("load", () => {
    for (const route of feed.routes) {
      map.addImage(`bus-${route.id}`, busIcon(route.color), { pixelRatio: 2 })
      map.addImage(`chevron-${route.id}`, chevronIcon(route.color), { pixelRatio: 2 })
    }

    map.addSource("routes",    { type: "geojson", data: collection([]) })
    map.addSource("stops",     { type: "geojson", data: collection(stopFeatures) })
    map.addSource("itinerary", { type: "geojson", data: collection([]) })
    map.addSource("vehicles",  { type: "geojson", data: collection([]) })

    const rounded = { "line-join": "round", "line-cap": "round" } as const
    const isRide = ["==", ["get", "kind"], "ride"] as any

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
    map.addLayer({
      id: "itinerary-walk",
      type: "line",
      source: "itinerary",
      filter: ["==", ["get", "kind"], "walk"],
      layout: rounded,
      paint: {
        "line-color": INK,
        "line-width": lineWidth(2.5, 5),
        "line-dasharray": [0.1, 2]
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
      const isTappable = nearestWithin(event.point, "vehicles") ?? nearestWithin(event.point, "stops")
      map.getCanvas().style.cursor = isTappable ? "pointer" : ""
    })

    // Buses first, then stops, else the spot itself
    map.on("click", event => {
      const bus = nearestWithin(event.point, "vehicles")
      if (bus)
        return onTap({ kind: "bus", id: bus.properties.id })

      const stop = nearestWithin(event.point, "stops")
      if (stop)
        return onTap({ kind: "stop", stop: stop.id as number })

      const { lng, lat } = event.lngLat
      onTap({ kind: "place", place: { lon: lng, lat, name: "Dropped pin" }, hints: hintsAt(event.point) })
    })

    // Only the routes shown share lanes, so they're laid out again when that changes
    const lanes = r(() => laneSlots(corridors, state.shownRoutes.value, routeOrder))
    const colors = new Map(feed.routes.map(route => [route.id, route.color]))
    watch(() => {
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

    // Draw the itinerary right away, then swap in street geometry for walks as it arrives
    let fitted: string | undefined
    watch(() => {
      const itinerary = state.itinerary.value
      const source = map.getSource<GeoJSONSource>("itinerary")!

      if (!itinerary) {
        source.setData(collection([]))
        fitted = undefined
        return
      }

      const paths = itinerary.legs.map(leg =>
        leg.kind === "ride"
          ? ridePath(feed, leg)
          : [[leg.from.lon, leg.from.lat], [leg.to.lon, leg.to.lat]] as Coordinates[]
      )
      const render = () =>
        source.setData(collection(itinerary.legs.map((leg, i) =>
          line(paths[i], {
            kind: leg.kind,
            color: leg.kind === "ride" ? feed.routesById.get(leg.run.trip.route)?.color : undefined
          })
        )))
      render()

      // Replanning with fresher times redraws the same trip without moving the map
      const key = JSON.stringify(paths)
      if (key !== fitted) {
        fitted = key
        const all = paths.flat()
        const lons = all.map(([lon]) => lon)
        const lats = all.map(([, lat]) => lat)
        show(padding =>
          map.fitBounds(
            [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
            { padding, maxZoom: 16.5 }
          )
        )
      }

      let isCurrent = true
      itinerary.legs.forEach(async (leg, i) => {
        if (leg.kind !== "walk")
          return
        paths[i] = await walkPath(leg.from, leg.to)
        if (isCurrent)
          render()
      })
      return () => isCurrent = false
    })

    watch(() => {
      const stop = state.selectedStop.value
      if (stop === undefined)
        return
      const { lon, lat } = feed.stops[stop]
      const zoom = Math.max(map.getZoom(), 16)
      show(padding => map.easeTo({ center: [lon, lat], zoom, padding }))
    })

    busPosition = animateBuses(map, feed, state.vehicles, state.layovers, state.focusedBuses)
    drawYou()
  })

  return { map }
}
