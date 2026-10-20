// What the map shows and the panel is about: the stop or bus selected, the routes shown, and which are picked
// out. Reactive values only, no DOM

import { r, watch } from "bruh/reactive"
import { renumbered } from "../../transit/feed.mts"
import type { MapData } from "./data.mts"
import type { createLive } from "./live.mts"
import type { createRiding } from "./riding.mts"
import type { createTrip } from "./trip.mts"
import { type Own, distinct, isSameSet } from "../../shell/state.mts"

const SOON = 3600 // s

/** What the map shows and the panel is about, as the timetable, the buses, and your trip change. own is given what stops it */
export const createView = (
  { feed, liveCounts, now, runningToday, runs, vehicles, riding, itinerary }:
    MapData & ReturnType<typeof createLive> & ReturnType<typeof createRiding> & ReturnType<typeof createTrip>,
  own: Own
) => {
  const selectedStop = r<number>()

  // A newer timetable may number its stops otherwise, so the selected stop is found again in it by its id
  let stopsBefore = feed.peek().stops
  own(watch([feed], () => {
    if (feed.value.stops === stopsBefore)
      return
    selectedStop.value = renumbered(selectedStop.peek(), stopsBefore, feed.value.stops)
    stopsBefore = feed.value.stops
  }))

  /** The selected stop's id, reaching what depends on it only when another stop is selected, not as it's renumbered */
  const selectedStopId = distinct(() => {
    const stop = selectedStop.value
    return stop === undefined ? undefined : feed.peek().stops[stop]?.id
  })
  /** The id of the bus tapped to see its stops */
  const selectedBus = r<string>()
  /** The bus whose stops the panel shows: one tapped, else the one you're on */
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
