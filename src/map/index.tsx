/** @jsxImportSource bruh/browser */

import "../shell/index.mts"
import "./index.css"

import { r, watch } from "bruh/reactive"
import { Popup } from "maplibre-gl"
import { createMap } from "./render/map.mts"
import { startMap } from "./state/map.mts"
import { AppTitle, Icon } from "../shell/ui.tsx"
import { Planner, Suggestions, editing } from "./ui/Planner.tsx"
import { Itineraries } from "./ui/Itineraries.tsx"
import { StopView } from "./ui/StopView.tsx"
import { RouteList, Status } from "./ui/RouteList.tsx"
import { PlaceCard } from "./ui/cards.tsx"
import { BusView, RideSuggestion } from "./ui/BusView.tsx"
import { makeSheet, raise } from "./ui/sheet.mts"
import { capture } from "../shell/usage.tsx"
import { distinct } from "../shell/state.mts"
import { coarseName } from "../places/coarse.mts"
import { localDay, localHour, weekday } from "../shared/time.mts"

const state = await startMap()
const { from, to, selected, itineraries, itinerary, buildings, feed, selectedStop, selectedBus, viewedBus, suggested, locationProblem, directTo } = state

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

// A trip planned is counted once both its ends are chosen, but not again as one from or to you moves with you, nor
// for one kept from earlier. Its ends are counted as coarse places, and it's sent unlinked (src/shell/events.mts)
const ends = distinct(() => from.value && to.value && `${from.value.name}\n${to.value.name}`)
let planned = ends.peek()
watch([ends], () => {
  if (ends.value && ends.value !== planned) {
    const named = [...buildings.peek(), ...feed.peek().stops]
    const at = Date.now()
    const [fromName, toName] = [from.peek()!, to.peek()!].map(end => coarseName(end, named, feed.peek().stops))
    // A task later, once the itineraries, which follow the ends a microtask late as this does, are the trip's
    setTimeout(() => capture("trip_planned", {
      from:         fromName,
      to:           toName,
      hour_of_week: weekday(localDay(at)) * 24 + localHour(at),
      itineraries:  itineraries.peek().length,
      rides_bus:    itinerary.peek()?.legs.some(leg => leg.kind === "ride") ?? false,
      walk_only:    !itineraries.peek().length
    }))
  }
  planned = ends.value
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
  state,
  tap => {
    if (card) {
      card.remove()
      return
    }

    if (tap.kind === "stop") {
      selectedStop.value = tap.stop
      capture("stop_opened")
    }
    else if (tap.kind === "bus") {
      selectedStop.value = undefined
      selectedBus.value = tap.id
      capture("bus_opened")
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
