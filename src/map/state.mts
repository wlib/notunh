// App state and live data: reactive values only, no DOM

import { r, watch } from "bruh/reactive"
import feedUrl from "./gtfs.json?url"
import { distance, isServiceActive, loadFeed, localDate } from "./feed.mts"
import { type Vehicle, type Prediction, type StopPredictions, STALE_VEHICLE_SECONDS, fetchVehicles, fetchPredictions, fetchStopPredictions } from "./umo.mts"
import { type Itinerary, type Place, buildRuns, itineraryKey, plan, timeAt, walkOnly, walkSeconds } from "./plan.mts"

const VEHICLE_POLL_MS = 5_000
const PREDICTION_POLL_MS = 30_000
const STOP_POLL_MS = 20_000
const CLOCK_TICK_MS = 15_000
// A request taking longer has stalled, and would hold up the next ones
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Runs f now and every interval while the page is visible, one run at a time,
 * until stopped, which cancels a run still going so it can't overwrite anything newer
 */
const poll = (f: (signal: AbortSignal) => Promise<unknown>, interval: number, onError: (error: unknown) => void = console.error) => {
  const controller = new AbortController()
  let isRunning = false
  const run = () => {
    if (isRunning || document.visibilityState !== "visible")
      return
    isRunning = true
    f(AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]))
      .catch(error => controller.signal.aborted || onError(error))
      .finally(() => isRunning = false)
  }
  run()
  const timer = setInterval(run, interval)
  document.addEventListener("visibilitychange", run)
  return () => {
    controller.abort()
    clearInterval(timer)
    document.removeEventListener("visibilitychange", run)
  }
}

export const feed = await loadFeed(feedUrl)

//#region Time

/** Epoch seconds, ticking */
export const now = r(Date.now() / 1000)
setInterval(() => now.value = Date.now() / 1000, CLOCK_TICK_MS)

// A source so that dependents only rerun when the date actually changes
export const today = r(localDate(Date.now()))
watch(() => {
  today.value = localDate(now.value * 1000)
})

export const runningToday = r(() =>
  new Set(
    feed.trips
      .filter(trip => isServiceActive(feed.services[trip.service], today.value))
      .map(trip => trip.route)
  )
)

//#endregion

//#region Live data

export const vehicles = r<Vehicle[]>([])
/** Epoch milliseconds of the last successful vehicles update */
export const lastUpdate = r<number>()
export const predictions = r<StopPredictions[]>([])

/** Buses reporting lately on routes in the timetable, which are the ones drawn on the map, by route */
export const liveCounts = r(() => {
  const counts = new Map<string, number>()
  for (const { route, secsSinceReport } of vehicles.value)
    if (route && feed.routesById.has(route.id) && secsSinceReport < STALE_VEHICLE_SECONDS)
      counts.set(route.id, (counts.get(route.id) ?? 0) + 1)
  return counts
})

const hasVehiclesFailed = r(false)

/** Umo has failed to answer from the start, or stopped answering for a while */
export const isLiveDown = r(() =>
  lastUpdate.value === undefined
    ? hasVehiclesFailed.value
    : now.value * 1000 - lastUpdate.value > 3 * VEHICLE_POLL_MS + CLOCK_TICK_MS
)

poll(
  async signal => {
    vehicles.value = await fetchVehicles(signal)
    lastUpdate.value = Date.now()
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

// A source keyed by the sorted route ids, so that a new bus going out refreshes right away
const liveRoutes = r<string>("")
watch(() => {
  liveRoutes.value = [...liveCounts.value.keys()].sort().join(" ")
})

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

export const runs = r(() => buildRuns(feed, today.value, predictions.value))

//#endregion

//#region Planning

export const from = r<Place>()
export const to = r<Place>()
/** The itineraryKey of the chosen itinerary, or "walk" */
export const selected = r<string>()

// A source with an equality cutoff, so cards only rerender when trips or times change
export const itineraries = r<Itinerary[]>([], {
  isEqual: (a, b) =>
    a.length === b.length &&
    a.every((itinerary, i) => itineraryKey(itinerary) === itineraryKey(b[i]))
})
watch(() => {
  itineraries.value =
    from.value && to.value
      ? plan(feed, runs.value, from.value, to.value, now.value)
      : []
})

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
/** The id of the bus whose card is open */
export const selectedBus = r<string>()
/** The route picked from the list to highlight */
export const pickedRoute = r<string>()
/** The selected bus's route, else the picked one */
export const highlightedRoute = r(() =>
  (selectedBus.value === undefined
    ? undefined
    : vehicles.value.find(vehicle => vehicle.id === selectedBus.value)?.route?.id
  ) ?? pickedRoute.value
)

/** Buses to pick out on the map: the ones an itinerary rides, else those on the selected bus's route */
export const focusedBuses = r((): { vehicles?: ReadonlySet<string>, route?: string } => {
  const rides = itinerary.value?.legs.filter(leg => leg.kind === "ride") ?? []
  if (rides.length)
    return { vehicles: new Set(rides.flatMap(leg => leg.run.vehicle ?? [])) }
  return { route: highlightedRoute.value }
})

const SOON = 3600 // s

const isSameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every(item => b.has(item))

/** Routes with a bus out or one due within the hour, else all of today's; a source so the map only redraws on a change */
export const activeRoutes = r<ReadonlySet<string>>(new Set<string>(), { isEqual: isSameSet })
watch(() => {
  const active = new Set(liveCounts.value.keys())
  for (const run of runs.value)
    if (timeAt(run, 0) <= now.value + SOON && timeAt(run, run.trip.stops.length - 1) >= now.value)
      active.add(run.trip.route)
  activeRoutes.value = active.size ? active : runningToday.value
})

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

export const useCurrentLocation = () =>
  new Promise<Place | undefined>(resolve =>
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lon: coords.longitude, name: "Your location" }),
      () => resolve(undefined),
      { enableHighAccuracy: true, timeout: 10_000 }
    )
  )

// Start from the current location if the user already allowed it
navigator.permissions?.query({ name: "geolocation" })
  .then(async status => {
    if (status.state === "granted" && !from.peek())
      from.value = await useCurrentLocation()
  })
  .catch(() => {})
