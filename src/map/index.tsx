/** @jsxImportSource bruh/browser */

import "../shell/index.mts"
import "./index.css"

import { r, watch } from "bruh/reactive"
import { Popup } from "maplibre-gl"
import { createMap } from "./map.mts"
import {
  feed, vehicles, layovers, from, to, selected, itinerary,
  selectedStop, selectedBus, highlightedRoute, focusedBuses, shownRoutes
} from "./state.mts"
import { AppTitle, Icon } from "../shell/ui.tsx"
import { Planner, Suggestions, editing } from "./ui/Planner.tsx"
import { Itineraries } from "./ui/Itineraries.tsx"
import { StopView } from "./ui/StopView.tsx"
import { RouteList, Status } from "./ui/RouteList.tsx"
import { BusCard, PlaceCard } from "./ui/cards.tsx"
import { isLowered, makeSheet } from "./ui/sheet.mts"

const clearTrip = () => {
  from.value = undefined
  to.value = undefined
  selected.value = undefined
}

const grabber = <button type="button" class="grabber" /> as HTMLElement

const header =
  <header class="panel-header">
    <AppTitle page="Map" />
    <Status />
    {r(() => (from.value || to.value) &&
      <button type="button" class="close" aria-label="Clear trip" title="Clear trip" onclick={clearTrip}>
        <Icon name="close" />
      </button>
    )}
  </header> as HTMLElement

const Panel = () =>
  <aside class="panel">
    {grabber}
    {header}
    <Planner />
    {r(() =>
      editing.value                    ? <Suggestions /> :
      selectedStop.value !== undefined ? <StopView stop={selectedStop.value} /> :
      from.value && to.value           ? <Itineraries /> :
                                         <RouteList />
    )}
  </aside>

const mapElement = <div class="map" /> as HTMLElement
const panel = <Panel /> as HTMLElement
document.getElementById("app")!.replaceChildren(mapElement, panel)

makeSheet(panel, grabber, header)
// Something new to show brings the sheet back up
watch([from, to, selectedStop], () => {
  isLowered.value = false
}, { skipFirst: true })

/** The one card open on the map; any tap closes it rather than doing something else */
let card: Popup | undefined

const openCard = (lngLat: [number, number], content: Node, onClose?: () => void) => {
  const popup = new Popup({ closeButton: false, closeOnClick: false, className: "map-card", offset: 16, maxWidth: "18rem" })
  popup.on("close", () => {
    if (card === popup)
      card = undefined
    onClose?.()
  })
  card = popup
  return popup.setLngLat(lngLat).setDOMContent(content).addTo(map)
}

const { map, busPosition } = createMap(
  mapElement,
  panel,
  feed,
  { vehicles, layovers, shownRoutes, highlightedRoute, from, to, selectedStop, itinerary, focusedBuses },
  tap => {
    if (card) {
      card.remove()
      return
    }

    if (tap.kind === "stop")
      selectedStop.value = tap.stop
    else if (tap.kind === "bus") {
      const position = busPosition(tap.id)
      if (!position)
        return
      // Ride along with the bus
      const follow = () => {
        const next = busPosition(tap.id)
        if (next)
          card?.setLngLat(next)
      }
      selectedBus.value = tap.id
      map.on("render", follow)
      openCard(position, <BusCard id={tap.id} />, () => {
        map.off("render", follow)
        selectedBus.value = undefined
      })
    }
    else
      openCard(
        [tap.place.lon, tap.place.lat],
        <PlaceCard place={tap.place} hints={tap.hints} close={() => card?.remove()} />
      )
  }
)
