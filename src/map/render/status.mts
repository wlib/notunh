// The map answering the sheet: while dining's page is shown, each hall says its standing where it stands, and while
// laundry's is, each residence hall its washers free, in green where there's one, with yours first and ringed in
// gold, and its name once the map is close enough to read it; the camera frames the halls, or for laundry the
// residence halls around the middle of campus, the outlying ones a pan away. Off those pages the map says none of it,
// as its buildings' quiet marks are enough until asked. A symbol layer of the map's own, over everything else of
// ours, so the map keeps the marks apart: one that would cover another gives way, yours and those with a washer
// free kept first

import type { GeoJSONSource, Map as MapLibre } from "maplibre-gl"
import { watch } from "bruh/reactive"
import { wallDate } from "../../dining/hours.mts"
import { roomAtSlug } from "../../laundry/rooms.mts"
import type { Building } from "../../places/buildings.mts"
import { CAMPUS } from "../../places/durham.mts"
import { distance } from "../../geo/projection.mts"
import type { MapState } from "../state/map.mts"
import type { Show } from "./camera.mts"
import { DENSITY } from "./icons.mts"
import { collection } from "./layers.mts"

export const STATUS = "status"

const clock = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" })

/** A hall's name as its mark has room for: its first word */
const short = (name: string) =>
  name.split(" ")[0]

const INK = "#1c1e24"
const MUTED = "#6b6f78"
const POSITIVE = "#0a7d3c"
const GOLD = "#c98a00"

// m from the middle of campus within which laundry's page frames the residence halls, the rest a pan away
const NEAR_M = 550

/**
 * A mark's ground: a white lozenge with a soft shadow, ringed where asked, which stretches across its middle to
 * whatever it says
 */
const lozenge = (ring?: string) => {
  const [width, height, radius, pad] = [30, 24, 8, 3].map(px => px * DENSITY)
  const canvas = Object.assign(document.createElement("canvas"), { width, height })
  const context = canvas.getContext("2d")!
  context.shadowColor = "rgb(20 24 40 / 0.3)"
  context.shadowBlur = 2 * DENSITY
  context.shadowOffsetY = 0.5 * DENSITY
  context.fillStyle = "white"
  context.beginPath()
  context.roundRect(pad, pad, width - 2 * pad, height - 2 * pad, radius)
  context.fill()
  if (ring) {
    context.shadowColor = "transparent"
    context.strokeStyle = ring
    context.lineWidth = 1.75 * DENSITY
    context.stroke()
  }
  return {
    image:   context.getImageData(0, 0, width, height),
    options: {
      pixelRatio: DENSITY,
      stretchX:   [[pad + radius, width - pad - radius]] as [number, number][],
      stretchY:   [[pad + radius, height - pad - radius]] as [number, number][],
      content:    [pad + radius * 0.55, pad, width - pad - radius * 0.55, height - pad] as [number, number, number, number]
    }
  }
}

/** Each building of the page's kind as a mark: what it says, far and near, how it stands, and how far it comes before the rest */
const features = (state: MapState, kind: Building["kind"]): GeoJSON.Feature[] =>
  state.buildings.value.filter(building => building.kind === kind).map(building => {
    const at = { type: "Point" as const, coordinates: [building.lon, building.lat] }
    if (kind === "dining") {
      const standing = state.hallsNow.value.find(hall => hall.name === building.name)?.standing
      const label =
        standing?.isOpen ? `${short(building.name)} · till ${clock.format(wallDate(standing.closes))}` :
        standing?.opens  ? `${short(building.name)} · opens ${clock.format(wallDate(standing.opens))}` :
                           `${short(building.name)} · closed`
      return { type: "Feature", geometry: at, properties: { name: building.name, label, near: label, color: standing?.isOpen ? INK : MUTED, ground: "status", rank: 0 } }
    }
    const rooms = building.rooms?.flatMap(slug => roomAtSlug(slug) ?? []) ?? []
    const counts = rooms.flatMap(room => state.countsOf(room.id) ?? [])
    const free = counts.reduce((sum, room) => sum + room.washer.free, 0)
    const isYours = rooms.some(room => state.starredRooms.value.has(room.id))
    const label = counts.length ? String(free) : "–"
    return {
      type: "Feature",
      geometry: at,
      properties: {
        name:   building.name,
        label,
        near:   `${label} · ${building.name.replace(/ Hall$/, "")}`,
        color:  free > 0 ? POSITIVE : MUTED,
        ground: isYours ? "status-yours" : "status",
        rank:   isYours ? 0 : free > 0 ? 1 : 2
      }
    }
  })

export const showStatus = (map: MapLibre, state: MapState, show: Show) => {
  map.addImage("status", lozenge().image, lozenge().options)
  map.addImage("status-yours", lozenge(GOLD).image, lozenge(GOLD).options)
  map.addSource(STATUS, { type: "geojson", data: collection([]) })
  map.addLayer({
    id: STATUS,
    type: "symbol",
    source: STATUS,
    layout: {
      "text-field": ["step", ["zoom"], ["get", "label"], 15.4, ["get", "near"]],
      "text-font": ["Noto Sans Bold"],
      "text-size": 12,
      "icon-image": ["get", "ground"],
      "icon-text-fit": "both",
      "text-max-width": 20,
      "symbol-sort-key": ["get", "rank"]
    },
    paint: { "text-color": ["get", "color"] }
  })

  watch(() => {
    const kind = state.page.value?.kind
    const isShown = kind === "dining" || kind === "laundry"
    map.getSource<GeoJSONSource>(STATUS)!.setData(collection(isShown ? features(state, kind) : []))
    // The buildings' quiet marks give way to what's said in their place
    map.setLayoutProperty("buildings", "visibility", isShown ? "none" : "visible")
  })

  // Each page frames what it's of as it opens
  let framed: string | undefined
  watch(() => {
    const kind = state.page.value?.kind
    const all = state.buildings.value.filter(building => building.kind === kind)
    const near = all.filter(building => distance(building, CAMPUS) <= NEAR_M)
    const of = near.length ? near : all
    if (of.length && kind !== framed)
      show(padding => {
        map.setPadding(padding)
        map.fitBounds(
          [[Math.min(...of.map(({ lon }) => lon)), Math.min(...of.map(({ lat }) => lat))], [Math.max(...of.map(({ lon }) => lon)), Math.max(...of.map(({ lat }) => lat))]],
          { padding: { top: 24, bottom: 16, left: 24, right: 48 }, maxZoom: 16.2, duration: 600 }
        )
      })
    framed = kind
  })
}
