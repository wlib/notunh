// The map answering the sheet: while dining's page is shown, each hall says its standing where it stands, and while
// laundry's is, each residence hall its washers free, lit where there's one and ringed where it's yours, the camera
// framing them all. Off those pages the map says none of it, as its buildings' quiet marks are enough until asked.
// Markers of the page's own rather than a layer of the map's, so they sit over the buses for as long as they're
// what's asked about, at most a few dozen at once

import { Marker, type Map as MapLibre } from "maplibre-gl"
import { watch } from "bruh/reactive"
import { wallDate } from "../../dining/hours.mts"
import { roomAtSlug } from "../../laundry/rooms.mts"
import type { Building } from "../../places/buildings.mts"
import type { MapState } from "../state/map.mts"
import type { Show } from "./camera.mts"

const clock = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" })

/** A hall's name as its pill has room for: its first word */
const short = (name: string) =>
  name.split(" ")[0]

export const showStatus = (map: MapLibre, state: MapState, show: Show) => {
  const markers = new Map<string, { marker: Marker, element: HTMLButtonElement }>()

  /** A building's pill, made once, which opens its place */
  const pillOf = (building: Building) => {
    const made = markers.get(building.id)
    if (made)
      return made
    const element = document.createElement("button")
    element.type = "button"
    element.className = "status-pill"
    element.addEventListener("click", event => {
      event.stopPropagation()
      state.go({ kind: "place", name: building.name })
    })
    const entry = { element, marker: new Marker({ element, anchor: "center" }).setLngLat([building.lon, building.lat]) }
    markers.set(building.id, entry)
    return entry
  }

  const dot = () =>
    Object.assign(document.createElement("span"), { className: "dot" })

  watch(() => {
    const kind = state.page.value?.kind
    for (const building of state.buildings.value) {
      if (building.kind !== kind) {
        markers.get(building.id)?.marker.remove()
        continue
      }
      const { element, marker } = pillOf(building)
      if (building.kind === "dining") {
        const standing = state.hallsNow.value.find(hall => hall.name === building.name)?.standing
        element.dataset.open = String(standing?.isOpen ?? false)
        element.replaceChildren(dot(),
          standing?.isOpen ? `${short(building.name)} · till ${clock.format(wallDate(standing.closes))}` :
          standing?.opens  ? `${short(building.name)} · opens ${clock.format(wallDate(standing.opens))}` :
                             `${short(building.name)} · closed`
        )
      }
      else {
        const rooms = building.rooms?.flatMap(slug => roomAtSlug(slug) ?? []) ?? []
        const counts = rooms.flatMap(room => state.countsOf(room.id) ?? [])
        const free = counts.reduce((sum, room) => sum + room.washer.free, 0)
        element.dataset.open = String(free > 0)
        element.dataset.yours = String(rooms.some(room => state.starredRooms.value.has(room.id)))
        element.setAttribute("aria-label", `${building.name}: ${counts.length ? `${free} washers free` : "not checked yet"}`)
        element.classList.add("count")
        element.replaceChildren(counts.length ? String(free) : "–")
        marker.getElement().style.zIndex = element.dataset.yours === "true" ? "2" : free > 0 ? "1" : "0"
      }
      marker.addTo(map)
    }
    // The buildings' quiet marks give way to what's said in their place
    map.setLayoutProperty("buildings", "visibility", kind === "dining" || kind === "laundry" ? "none" : "visible")
  })

  // Each page frames what it's of as it opens: the two halls, or every hall with a laundry room
  let framed: string | undefined
  watch(() => {
    const kind = state.page.value?.kind
    const of = state.buildings.value.filter(building => building.kind === kind)
    if (of.length && kind !== framed)
      show(padding => {
        map.setPadding(padding)
        map.fitBounds(
          [[Math.min(...of.map(({ lon }) => lon)), Math.min(...of.map(({ lat }) => lat))], [Math.max(...of.map(({ lon }) => lon)), Math.max(...of.map(({ lat }) => lat))]],
          { padding: { top: 56, bottom: 28, left: 40, right: 72 }, maxZoom: 16.2, duration: 600 }
        )
      })
    framed = kind
  })
}
