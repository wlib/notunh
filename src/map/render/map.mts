import "maplibre-gl/dist/maplibre-gl.css"
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
import { Map as MapLibre, AttributionControl, Marker, NavigationControl, addProtocol, setWorkerUrl } from "maplibre-gl"
import { watch } from "bruh/reactive"
import type { StyleSpecification } from "maplibre-gl"
import type { Coordinates } from "../../geo/projection.mts"
import type { MapState } from "../state/map.mts"
import { DRAWN_ICONS, glyphsFrom, hostedAt, upstreamGlyphs } from "../basemap/style.mts"
import { PROTOCOL, tileLoader } from "../basemap/tiles.mts"
import { type Aim, type Show, aimed, framing } from "./camera.mts"
import { viewOf } from "../link.mts"
import type { Place } from "../../places/search.mts"
import { DENSITY, poiIcon } from "./icons.mts"
import { addLayers, drawLayers } from "./layers.mts"
import { drawItinerary } from "./itinerary.mts"
import { type Tap, dropPins, listenForTaps } from "./taps.mts"
import { animateBuses } from "./buses.mts"
import { showYou } from "./you.mts"
import { CAMPUS } from "../../places/durham.mts"

/**
 * The place of the page the sheet shows, marked with its label, and today's other labels hidden meanwhile, so it's
 * the one place named
 */
const showFocus = (map: MapLibre, state: MapState) => {
  const element = document.createElement("div")
  element.className = "focus-marker"
  const marker = new Marker({ element, anchor: "center" })
  watch([state.page, state.focus], () => {
    const focus = state.focus.value?.view === viewOf(state.page.value) ? state.focus.value : undefined
    map.setLayoutProperty("event-labels", "visibility", focus ? "none" : "visible")
    if (!focus)
      return void marker.remove()
    const { place: { lon, lat }, label } = focus
    element.textContent = label
    marker.setLngLat([lon, lat]).addTo(map)
  })
}

/** Where a trip's end is, or "you" wherever you've got to */
const endKey = (place: Place | undefined) =>
  place?.isYou ? "you" : place && `${place.lat},${place.lon}`

/**
 * The camera follows the page shown and nothing else: its place, its stop, or for directions the whole trip. It
 * moves once as a page opens, and again only when what that page shows is another place or trip (aimed in
 * camera.mts), so a trip planned again with fresher times, a clock tick, or a page no longer shown never moves it
 */
const followPage = (map: MapLibre, state: MapState, show: Show) => {
  let held: Aim | undefined
  watch(() => {
    const page = state.page.value
    const view = viewOf(page)
    const focus = state.focus.value?.view === view ? state.focus.value : undefined
    const stop = page?.kind === "stop" ? state.feed.value.stops[state.selectedStop.value ?? -1] : undefined
    const paths = page?.kind === "directions" && state.itinerary.value ? state.legPaths.value : []
    const all = paths.flatMap(path => path.coordinates)
    const spot = focus?.place ?? stop
    const target =
      spot       ? `${spot.lon},${spot.lat}` :
      all.length ? `${endKey(state.from.value)} ${endKey(state.to.value)} ${state.selected.value}` :
                   undefined
    const { held: next, move } = aimed(held, { view, target })
    held = next
    if (!move)
      return
    if (spot)
      show(padding => map.easeTo({ center: [spot.lon, spot.lat], zoom: Math.max(map.getZoom(), 16), padding }))
    else {
      const lons = all.map(([lon]) => lon)
      const lats = all.map(([, lat]) => lat)
      // maplibre fits bounds within the padding it was given and the map's own padding together, so the panel's
      // is set as the map's alone
      show(padding => {
        map.setPadding(padding)
        map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { maxZoom: 16.5 })
      })
    }
  })
}

// maplibre finds its worker with a computed URL that vite can't see, so bundle it as a worker explicitly
setWorkerUrl(workerUrl)

/** Where the map opens, on campus */
const OPENING: Coordinates = [CAMPUS.lon, CAMPUS.lat]

/**
 * Draws the map, following the data as newer builds swap it in: the timetable's stops and routes, the model the
 * buses are driven by, the gazetteer taps are named from, the laundry and dining buildings, and which week's tiles
 * are ours
 */
export const createMap = (
  container: HTMLElement,
  panel: HTMLElement,
  state: MapState,
  onTap: (tap: Tap) => void
) => {
  // The style's tiles, ours where we have them, from the folder of the week the data names
  let version = state.tiles.peek().version
  addProtocol(PROTOCOL, tileLoader(version))
  // Glyphs outside the ranges kept with our style come from where it says
  let upstream: string | undefined
  const map = new MapLibre({
    container,
    center: OPENING,
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
  // A newer build's style comes in as the differences from the one showing, so nothing flickers. It's loaded together
  // with its manifest, so the map never applies a style it doesn't have
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
  const drawYou = showYou(map, panel, state, id => busPosition(id))

  const show = framing(container, panel)
  show(padding => map.jumpTo({ center: OPENING, padding }))
  dropPins(map, state)

  map.on("load", () => {
    addLayers(map)
    listenForTaps(map, state, onTap)
    drawLayers(map, state)
    drawItinerary(map, state)
    showFocus(map, state)
    followPage(map, state, show)

    busPosition = animateBuses(map, state.feed, state.drawn, state.focusedBuses)
    drawYou()
  })

  return { map }
}
