import "maplibre-gl/dist/maplibre-gl.css"
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
import { Map as MapLibre, AttributionControl, NavigationControl, addProtocol, setWorkerUrl } from "maplibre-gl"
import { watch } from "bruh/reactive"
import type { StyleSpecification } from "maplibre-gl"
import type { Coordinates } from "../../geo/projection.mts"
import type { MapState } from "../state/map.mts"
import { DRAWN_ICONS, glyphsFrom, hostedAt, upstreamGlyphs } from "../basemap/style.mts"
import { PROTOCOL, tileLoader } from "../basemap/tiles.mts"
import { framing } from "./camera.mts"
import { DENSITY, poiIcon } from "./icons.mts"
import { addLayers, drawLayers } from "./layers.mts"
import { drawItinerary } from "./itinerary.mts"
import { type Tap, dropPins, listenForTaps } from "./taps.mts"
import { animateBuses } from "./buses.mts"
import { showYou } from "./you.mts"

// maplibre finds its worker with a computed URL that vite can't see, so bundle it as a worker explicitly
setWorkerUrl(workerUrl)

const DURHAM: Coordinates = [-70.9345, 43.1365]

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
  show(padding => map.jumpTo({ center: DURHAM, padding }))
  dropPins(map, state)

  map.on("load", () => {
    addLayers(map)
    listenForTaps(map, state.buildings, onTap)
    drawLayers(map, state)
    drawItinerary(map, state, show)

    // Once for each stop selected, and not again as a newer timetable renumbers it
    watch([state.selectedStopId], () => {
      const stop = state.feed.peek().stops.find(stop => stop.id === state.selectedStopId.value)
      if (!stop)
        return
      const zoom = Math.max(map.getZoom(), 16)
      show(padding => map.easeTo({ center: [stop.lon, stop.lat], zoom, padding }))
    })

    busPosition = animateBuses(map, state.feed, state.drawn, state.focusedBuses)
    drawYou()
  })

  return { map }
}
