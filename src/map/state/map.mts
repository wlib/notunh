// The map page's state: your location, the live buses, which you're on, your trip, today's events, the courses,
// parking, the page the sheet shows, and what the map shows. Starting it starts its polling and watching, and stop
// ends them, so the page owns the one it starts, and a test can make its own

import { type MapData, loadMapData } from "./data.mts"
import { createLocation } from "./location.mts"
import { createLive } from "./live.mts"
import { createRiding } from "./riding.mts"
import { createTrip } from "./trip.mts"
import { createView } from "./view.mts"
import { createToday } from "./today.mts"
import { createCoursesState } from "./courses.mts"
import { createPage } from "./page.mts"
import { createParkingState } from "./parking.mts"
import type { Own } from "../../shell/state.mts"

export const createMapState = (data: MapData) => {
  const stops: (() => void)[] = []
  const own: Own = stop => stops.push(stop)
  const location = createLocation(own)
  const live = createLive(data, own)
  const riding = createRiding({ ...data, ...location, ...live }, own)
  const trip = createTrip({ ...data, ...location, ...live, ...riding }, own)
  const today = createToday({ ...data, ...live }, own)
  const courses = createCoursesState({ ...data, ...live })
  const parking = createParkingState(data)
  const state = { ...data, ...location, ...live, ...riding, ...trip, ...today, ...courses, ...parking, ...createPage(own) }
  return { ...state, ...createView(state), stop: () => stops.splice(0).forEach(stop => stop()) }
}

export type MapState = ReturnType<typeof createMapState>

/** The page's map state, for its views to read as they show, once the page has started it */
export let state: MapState

/** Starts the page's map state from its bundled data */
export const startMap = async () =>
  state = createMapState(await loadMapData())
