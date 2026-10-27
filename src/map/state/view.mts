// What the map shows and the panel is about: the stop or bus whose page is shown, the routes shown, and which are
// picked out. Reactive values only, no DOM

import { r } from "bruh/reactive"
import type { MapData } from "./data.mts"
import type { createLive } from "./live.mts"
import type { createRiding } from "./riding.mts"
import type { createTrip } from "./trip.mts"
import type { createPage } from "./page.mts"
import { distinct, isSameSet } from "../../shell/state.mts"

const SOON = 3600 // s

/** What the map shows and the panel is about, as the timetable, the buses, and your trip change */
export const createView = (
  { feed, liveCounts, now, runningToday, runs, vehicles, riding, itinerary, page }:
    MapData & ReturnType<typeof createLive> & ReturnType<typeof createRiding> & ReturnType<typeof createTrip> & ReturnType<typeof createPage>
) => {
  /** The id of the stop whose page is shown */
  const selectedStopId = r(() => page.value?.kind === "stop" ? page.value.id : undefined)
  /** Its index in the timetable, found again by its id as a newer timetable renumbers its stops */
  const selectedStop = r(() => {
    const id = selectedStopId.value
    const index = id === undefined ? -1 : feed.value.stops.findIndex(stop => stop.id === id)
    return index < 0 ? undefined : index
  })
  /** The id of the bus whose page is shown */
  const selectedBus = r(() => page.value?.kind === "bus" ? page.value.id : undefined)
  /** The bus the panel is about: the one whose page is shown, else the one you're on */
  const viewedBus = r(() => selectedBus.value ?? riding.value)

  /** The route picked from the list to highlight */
  const pickedRoute = r<string>()
  /** The viewed bus's route, else the picked one */
  const highlightedRoute = r(() =>
    (viewedBus.value === undefined
      ? undefined
      : vehicles.value.find(vehicle => vehicle.id === viewedBus.value)?.route?.id
    ) ?? pickedRoute.value
  )

  /** Buses to pick out on the map: the viewed one, else the ones an itinerary rides, else those on the picked route */
  const focusedBuses = r((): { vehicles?: ReadonlySet<string>, route?: string } => {
    if (viewedBus.value !== undefined)
      return { vehicles: new Set([viewedBus.value]) }
    const rides = itinerary.value?.legs.filter(leg => leg.kind === "ride") ?? []
    if (rides.length)
      return { vehicles: new Set(rides.flatMap(leg => leg.run.vehicle ?? [])) }
    return { route: highlightedRoute.value }
  })

  /** Routes with a bus out or one due within the hour, else all of today's, reaching the map only on a change */
  const activeRoutes = distinct((): ReadonlySet<string> => {
    const active = new Set(liveCounts.value.keys())
    for (const run of runs.value)
      if (run.departures[0] <= now.value + SOON && run.departures.at(-1)! >= now.value)
        active.add(run.trip.route)
    return active.size ? active : runningToday.value
  }, isSameSet)

  /** Routes the user chose to show, overriding the active ones */
  const chosenRoutes = r<ReadonlySet<string>>()
  const shownRoutes = r(() => chosenRoutes.value ?? activeRoutes.value)

  return { selectedStop, selectedStopId, selectedBus, viewedBus, pickedRoute, highlightedRoute, focusedBuses, chosenRoutes, shownRoutes }
}
