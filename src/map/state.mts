// App state and live data: reactive values only, no DOM

import { r, watch } from "bruh/reactive"
import feedUrl from "./gtfs.json?url"
import modelUrl from "./model.json?url"
import { distance, isServiceActive, loadFeed } from "./feed.mts"
import { loadModel } from "./model.mts"
import { type Vehicle, type Prediction, type StopPredictions, STALE_VEHICLE_SECONDS, fetchVehicles, fetchPredictions, fetchStopPredictions } from "./umo.mts"
import { type Itinerary, type Place, buildRuns, itineraryKey, plan, timeAt, walkOnly, walkSeconds } from "./plan.mts"
import { currentLocation, location, locationProblem } from "./location.mts"
import { buildingAt } from "./places.mts"
import { poll } from "../shell/poll.mts"
import { TICK_MS, now as clock, today, visibleSince } from "../shell/lifecycle.mts"
import { distinct, isSameList, isSameSet, store, stored } from "../shell/state.mts"

const VEHICLE_POLL_MS    = 5_000
const PREDICTION_POLL_MS = 30_000
const STOP_POLL_MS       = 20_000

export const [feed, model] = await Promise.all([loadFeed(feedUrl), loadModel(modelUrl)])

//#region Time

/** The shell's clock in epoch seconds, as the planner compares it with the timetable */
export const now = r(() => clock.value / 1000)

export const runningToday = r(() =>
  new Set(
    feed.trips
      .filter(trip => isServiceActive(feed.services[trip.service], today.value))
      .map(trip => trip.route)
  )
)

//#endregion

//#region Live data

/** Every vehicle as Umo last listed it */
const reports = r<Vehicle[]>([])
/** Epoch milliseconds of the last successful vehicles update */
export const lastUpdate = r<number>()
export const predictions = r<StopPredictions[]>([])

/** Seconds since a vehicle reported, as of an epoch millisecond, counting on from when Umo said so */
export const ageOf = (vehicle: Vehicle, at: number) =>
  vehicle.secsSinceReport + Math.max(0, at - (lastUpdate.value ?? at)) / 1000

/**
 * Milliseconds Umo has gone unheard while we've been listening, which is only while the page is in view, so
 * coming back gives it a moment to answer before anything is given up on
 */
const silence = r(() =>
  visibleSince.value === undefined
    ? 0
    : clock.value - Math.max(lastUpdate.value ?? -Infinity, visibleSince.value)
)

const hasVehiclesFailed = r(false)

/**
 * Umo has failed to answer from the start, or stopped answering for a while since we've been looking, until it
 * answers again, so that going away and coming back doesn't forget it
 */
export const isLiveDown = r(false)
watch(() => {
  if (lastUpdate.value === undefined ? hasVehiclesFailed.value : silence.value > 3 * VEHICLE_POLL_MS + TICK_MS)
    isLiveDown.value = true
})

/**
 * Buses still reporting; the rest are parked or off duty, and drop off as they age even when Umo can't be
 * reached, though only once it's had a chance to answer. Only a change in which buses those are reaches what
 * depends on them
 */
export const vehicles = distinct(() => {
  // Silence is negative for a moment on coming back, before the clock catches up
  const unheard = Math.max(0, silence.value) / 1000
  return reports.value.filter(vehicle =>
    (isLiveDown.value ? ageOf(vehicle, clock.value) : vehicle.secsSinceReport + unheard) < STALE_VEHICLE_SECONDS
  )
}, isSameList)

/** Live buses on routes in the timetable, which are the ones drawn on the map, by route */
export const liveCounts = r(() => {
  const counts = new Map<string, number>()
  for (const { route } of vehicles.value)
    if (route && feed.routesById.has(route.id))
      counts.set(route.id, (counts.get(route.id) ?? 0) + 1)
  return counts
})

poll(
  async signal => {
    reports.value = await fetchVehicles(signal)
    lastUpdate.value = Date.now()
    isLiveDown.value = false
  },
  VEHICLE_POLL_MS,
  error => {
    hasVehiclesFailed.value = true
    console.error(error)
  }
)

// Predictions only matter for routes with a bus out; the schedule covers the rest
const predictionPairs = [
  ...new Map(
    feed.trips.flatMap(trip =>
      // Nothing departs a trip's last stop
      trip.stops.slice(0, -1).map(stop => {
        const pair = { route: trip.route, stop: feed.stops[stop].id }
        return [`${pair.route}:${pair.stop}`, pair] as const
      })
    )
  ).values()
]

// Keyed by the sorted route ids, so that a new bus going out refreshes right away, and nothing else does
const liveRoutes = distinct(() => [...liveCounts.value.keys()].sort().join(" "))

watch([liveRoutes], () => {
  const routes = new Set(liveRoutes.value.split(" "))
  const pairs = predictionPairs.filter(pair => routes.has(pair.route))
  if (!pairs.length) {
    predictions.value = []
    return
  }
  return poll(async signal => {
    predictions.value = await fetchPredictions(pairs, signal)
  }, PREDICTION_POLL_MS)
})

/** Buses waiting out a layover: their soonest prediction is from the schedule, not from them driving */
export const layovers = r(() => {
  const soonest = new Map<string, Prediction>()
  for (const entry of predictions.value)
    for (const prediction of entry.values) {
      const current = soonest.get(prediction.vehicleId)
      if (!current || prediction.timestamp < current.timestamp)
        soonest.set(prediction.vehicleId, prediction)
    }
  return new Set([...soonest].filter(([, prediction]) => prediction.affectedByLayover).map(([id]) => id))
})

export const runs = r(() => buildRuns(feed, today.value, predictions.value, model))

//#endregion

//#region Planning

const isPlace = (value: unknown): value is Place => {
  const { lat, lon, name }: { lat?: unknown, lon?: unknown, name?: unknown } = Object(value)
  return typeof lat === "number" && typeof lon === "number" && typeof name === "string"
}

// The trip being planned is kept for the rest of the day, so the page reloading, as it does after a while away,
// picks it back up
const TRIP = "map-trip"
const trip: { day?: unknown, from?: unknown, to?: unknown, selected?: unknown } = Object(stored(TRIP))
const isTripToday = trip.day === today.peek()

export const from = r(isTripToday && isPlace(trip.from) ? trip.from : undefined)
export const to = r(isTripToday && isPlace(trip.to) ? trip.to : undefined)
/** The itineraryKey of the chosen itinerary, or "walk" */
export const selected = r(isTripToday && typeof trip.selected === "string" ? trip.selected : undefined)
watch(() => {
  store(TRIP, { day: today.peek(), from: from.value, to: to.value, selected: selected.value })
})

// Cards only rerender when trips or times change
export const itineraries = distinct(
  (): Itinerary[] => from.value && to.value ? plan(feed, runs.value, from.value, to.value, now.value) : [],
  (a, b) => isSameList(a.map(itineraryKey), b.map(itineraryKey))
)

/** Minutes and meters to walk the whole way, if worth suggesting */
export const walk = r(() => {
  if (!from.value || !to.value)
    return

  const meters = distance(from.value, to.value)
  const minutes = Math.max(1, Math.round(walkSeconds(meters) / 60))
  const [best] = itineraries.value
  // Short walks, walks not much longer than the bus, or the only option
  const isWorthIt =
    !best ||
    minutes <= 30 ||
    minutes * 60 <= 1.5 * (best.end - best.start)
  return isWorthIt ? { minutes, meters } : undefined
})

export const itinerary = r((): Itinerary | undefined => {
  if (selected.value === "walk" && from.value && to.value)
    return walkOnly(from.value, to.value, now.peek())
  return (
    itineraries.value.find(itinerary => itineraryKey(itinerary) === selected.value) ??
    itineraries.value[0]
  )
})

//#endregion

//#region Map

export const selectedStop = r<number>()
/** The id of the bus tapped to see its stops */
export const selectedBus = r<string>()
/** The bus you're on, by vehicle id */
export const riding = r<string>()
/** A bus you seem to be on, to ask about */
export const suggested = r<string>()
/** The bus whose stops the panel shows: one tapped, else the one you're on */
export const viewedBus = r(() => selectedBus.value ?? riding.value)

/** The route picked from the list to highlight */
export const pickedRoute = r<string>()
/** The viewed bus's route, else the picked one */
export const highlightedRoute = r(() =>
  (viewedBus.value === undefined
    ? undefined
    : vehicles.value.find(vehicle => vehicle.id === viewedBus.value)?.route?.id
  ) ?? pickedRoute.value
)

/** Buses to pick out on the map: the viewed one, else the ones an itinerary rides, else those on the picked route */
export const focusedBuses = r((): { vehicles?: ReadonlySet<string>, route?: string } => {
  if (viewedBus.value !== undefined)
    return { vehicles: new Set([viewedBus.value]) }
  const rides = itinerary.value?.legs.filter(leg => leg.kind === "ride") ?? []
  if (rides.length)
    return { vehicles: new Set(rides.flatMap(leg => leg.run.vehicle ?? [])) }
  return { route: highlightedRoute.value }
})

const SOON = 3600 // s

/** Routes with a bus out or one due within the hour, else all of today's, reaching the map only on a change */
export const activeRoutes = distinct((): ReadonlySet<string> => {
  const active = new Set(liveCounts.value.keys())
  for (const run of runs.value)
    if (timeAt(run, 0) <= now.value + SOON && timeAt(run, run.trip.stops.length - 1) >= now.value)
      active.add(run.trip.route)
  return active.size ? active : runningToday.value
}, isSameSet)

/** Routes the user chose to show, overriding the active ones */
export const chosenRoutes = r<ReadonlySet<string>>()
export const shownRoutes = r(() => chosenRoutes.value ?? activeRoutes.value)

/** The selected stop's predictions, undefined until they first load, and empty if they can't */
export const stopPredictions = r<StopPredictions[]>()
watch(() => {
  const stop = selectedStop.value
  stopPredictions.value = undefined
  if (stop === undefined)
    return

  return poll(
    async signal => {
      stopPredictions.value = await fetchStopPredictions(feed.stops[stop].id, signal)
    },
    STOP_POLL_MS,
    error => {
      // The schedule still says when buses should come
      stopPredictions.value ??= []
      console.error(error)
    }
  )
})

//#endregion

//#region You

const REPLAN_M = 50 // m moved before a trip from or to you is planned again

/** Where you are, as a place to plan from, moving only by enough to matter to a plan */
const you = r<Place | undefined>(undefined, {
  isEqual: (a, b) => a !== undefined && b !== undefined && distance(a, b) < REPLAN_M
})
watch(() => {
  const fix = location.value
  if (fix)
    you.value = { lat: fix.lat, lon: fix.lon, name: "Your location", isYou: true }
})

// A trip from or to you moves with you, except while you're on a bus, which a plan from where you are would have
// you get off
for (const place of [from, to])
  watch([you, riding], () => {
    if (place.peek()?.isYou && you.value && !riding.peek())
      place.value = you.value
  })

export const isLocating = r(false)

/** The current location as a place, or undefined with locationProblem saying why, unless quiet */
export const useCurrentLocation = async ({ quiet = false } = {}): Promise<Place | undefined> => {
  locationProblem.value = undefined
  isLocating.value = true
  try {
    const { lat, lon } = await currentLocation()
    return { lat, lon, name: "Your location", isYou: true }
  }
  catch (problem) {
    if (!quiet)
      locationProblem.value = problem as string
  }
  finally {
    isLocating.value = false
  }
}

/** Directions to a place, from where you are unless the trip already starts somewhere */
export const directTo = async (place: Place) => {
  to.value = place
  selected.value = undefined
  if (from.peek())
    return
  const here = await useCurrentLocation()
  // Unless you've picked somewhere while waiting
  if (here && !from.peek())
    from.value = here
}

// A link from the laundry or dining pages, like /map/?to=laundry/stoke-hall-g05, gives directions from where you are
// to the building, over any trip kept from earlier, and is then forgotten, so a reload keeps the trip as you've
// changed it since. Links to anywhere unknown are ignored
const link = new URLSearchParams(globalThis.location.search).get("to")
if (link !== null) {
  history.replaceState(history.state, "", globalThis.location.pathname)
  const building = buildingAt(link)
  if (building) {
    from.value = undefined
    directTo({ lat: building.lat, lon: building.lon, name: building.name })
  }
}

// Start from the current location if the user already allowed it, and otherwise don't keep a trip from or to
// where you were, as there's no following you from there. Browsers without the permissions API, before iOS 16,
// keep it until you next locate yourself
navigator.permissions?.query({ name: "geolocation" })
  .then(async status => {
    if (status.state !== "granted") {
      for (const place of [from, to])
        if (place.peek()?.isYou)
          place.value = undefined
    }
    else if (!from.peek()) {
      const here = await useCurrentLocation({ quiet: true })
      // Unless you've picked somewhere while waiting
      if (!from.peek())
        from.value = here
    }
  })
  .catch(() => {})

//#endregion
