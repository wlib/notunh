/** @jsxImportSource bruh/browser */

import "../shell/index.mts"
import "./index.css"

import { r, watch } from "bruh/reactive"
import { Popup } from "maplibre-gl"
import { createMap } from "./map.mts"
import {
  feed, model, layovers, from, to, selected, itinerary, selectedStop, selectedBus,
  riding, suggested, viewedBus, highlightedRoute, focusedBuses, shownRoutes, directTo
} from "./state.mts"
import { locationProblem } from "./location.mts"
import { fusedVehicles } from "./riding.mts"
import { AppTitle, Icon } from "../shell/ui.tsx"
import { Planner, Suggestions, editing } from "./ui/Planner.tsx"
import { Itineraries } from "./ui/Itineraries.tsx"
import { StopView } from "./ui/StopView.tsx"
import { RouteList, Status } from "./ui/RouteList.tsx"
import { PlaceCard } from "./ui/cards.tsx"
import { BusView, RideSuggestion } from "./ui/BusView.tsx"
import { makeSheet, raise } from "./ui/sheet.mts"

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
    <RideSuggestion />
    {r(() =>
      editing.value                    ? <Suggestions /> :
      selectedStop.value !== undefined ? <StopView stop={selectedStop.value} /> :
      viewedBus.value !== undefined    ? <BusView id={viewedBus.value} /> :
      from.value && to.value           ? <Itineraries /> :
                                         <RouteList />
    )}
  </aside>

const mapElement = <div class="map" /> as HTMLElement
const panel = <Panel /> as HTMLElement
document.getElementById("app")!.replaceChildren(mapElement, panel)

makeSheet(panel, grabber, header)
// Something new to show brings the sheet back up
watch([from, to, selectedStop, selectedBus], raise, { skipFirst: true })
// And so does a question or a problem for you
watch(() => {
  if (suggested.value || locationProblem.value)
    raise()
})

/** The one card open on the map; any tap closes it rather than doing something else */
let card: Popup | undefined

const openCard = (lngLat: [number, number], content: Node) => {
  const popup = new Popup({ closeButton: false, closeOnClick: false, className: "map-card", offset: 16, maxWidth: "18rem" })
  popup.on("close", () => {
    if (card === popup)
      card = undefined
  })
  card = popup
  return popup.setLngLat(lngLat).setDOMContent(content).addTo(map)
}

const { map } = createMap(
  mapElement,
  panel,
  feed,
  { model, vehicles: fusedVehicles, layovers, shownRoutes, highlightedRoute, from, to, selectedStop, itinerary, focusedBuses, riding },
  tap => {
    if (card) {
      card.remove()
      return
    }

    if (tap.kind === "stop")
      selectedStop.value = tap.stop
    else if (tap.kind === "bus") {
      selectedStop.value = undefined
      selectedBus.value = tap.id
    }
    else if (tap.kind === "building") {
      selectedStop.value = undefined
      selectedBus.value = undefined
      directTo(tap.place)
    }
    else
      openCard(
        [tap.place.lon, tap.place.lat],
        <PlaceCard place={tap.place} hints={tap.hints} close={() => card?.remove()} />
      )
  }
)
