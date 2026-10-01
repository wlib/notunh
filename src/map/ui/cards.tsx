/** @jsxImportSource bruh/browser */

// Cards that open on the map: a bus, or a spot to get directions to or from

import { r, type SourceNode } from "bruh/reactive"
import type { Place } from "../plan.mts"
import { nameAt, type MapHints } from "../osm.mts"
import { feed, vehicles, lastUpdate, predictions, from, to, shownRoutes, chosenRoutes } from "../state.mts"
import { Minutes, ago } from "../../shell/intl.tsx"
import { RouteBadge, route } from "./common.tsx"

/** Epoch milliseconds, ticking every second for "Last seen 5s ago" */
const second = r(Date.now())
setInterval(() => second.value = Date.now(), 1000)

export const BusCard = ({ id }: { id: string }) =>
  <div class="map-card-body">
    {r(() => {
      const vehicle = vehicles.value.find(vehicle => vehicle.id === id)
      if (!vehicle?.route || !feed.routesById.has(vehicle.route.id))
        return <p class="muted">This bus stopped reporting.</p>

      const busRoute = route(vehicle.route.id)
      const isOnlyRoute = r(() => shownRoutes.value.size === 1 && shownRoutes.value.has(busRoute.id))
      const next = predictions.value
        .flatMap(entry => entry.values
          .filter(value => value.vehicleId === id && value.timestamp >= second.peek())
          .map(value => ({ stop: entry.stop.name, ...value }))
        )
        .sort((a, b) => a.timestamp - b.timestamp)[0]

      return (
        <>
          <header class="bus-card-header">
            <RouteBadge route={busRoute} />
            <strong>{busRoute.long}</strong>
          </header>
          {vehicle.dir && vehicle.dir.dirNameShort !== busRoute.long && <p class="muted">{vehicle.dir.dirNameShort}</p>}
          {next && <p>Next stop: {next.stop}, {next.minutes ? <>in <Minutes value={next.minutes} /></> : "now"}</p>}
          <p class="muted">
            Last seen {r(() => ago(vehicle.secsSinceReport + (second.value - (lastUpdate.value ?? second.value)) / 1000))}
          </p>
          <button
            type="button"
            class="button"
            onclick={() => chosenRoutes.value = isOnlyRoute.peek() ? undefined : new Set([busRoute.id])}
          >
            {r(() => isOnlyRoute.value ? "Show all routes" : "Show only this route")}
          </button>
        </>
      )
    })}
  </div>

export const PlaceCard = ({ place, hints, close }: { place: Place, hints: MapHints, close: () => void }) => {
  const found = nameAt(place, hints).catch(() => undefined)
  const name = r<string>()
  found.then(result => name.value = result ?? place.name)

  // Use the name if it's known, and fill it in once it is
  const pick = (target: SourceNode<Place | undefined>) => () => {
    const chosen = { ...place, name: name.peek() ?? place.name }
    target.value = chosen
    close()
    found.then(result => {
      if (result && target.peek() === chosen)
        target.value = { ...chosen, name: result }
    })
  }

  return (
    <div class="map-card-body">
      <strong>{r(() => name.value ?? "Finding this place…")}</strong>
      <div class="map-card-actions">
        <button type="button" class="button" onclick={pick(from)}>Directions from here</button>
        <button type="button" class="button" onclick={pick(to)}>Directions to here</button>
      </div>
    </div>
  )
}
