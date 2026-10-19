// App state and live data: reactive values only, no DOM

import { r, watch } from "bruh/reactive"
import * as v from "valibot"
import { boardableStops, isServiceActive, loadFeed, renumbered } from "./feed.mts"
import { WalkData, loadGraph } from "./graph.mts"
import { type Progress, type Walk, type Walks, createWalks, isOffPath, walkOn, walkSeconds } from "./walks.mts"
import { type Line, sliceLine, toLine } from "../geo/lines.mts"
import { type Coordinates, distance } from "../geo/projection.mts"
import { ridePath } from "./shapes.mts"
import { Model, emptyModel } from "./model.mts"
import { loadStyle } from "./style.mts"
import { TilesManifest } from "./tiles.mts"
import { type Vehicle, type StopPredictions, STALE_VEHICLE_SECONDS, fetchVehicles, fetchPredictions, forecastOf } from "./umo.mts"
import { type Observation, NO_FORECAST, buildRuns, timeAt } from "./forecast.mts"
import { type Fixed, follow } from "./tracking.mts"
import { type Itinerary, type Place, type WalkLeg, isSameItinerary, itineraryKey, plan, walkOnly } from "./plan.mts"
import { currentLocation, location, locationProblem } from "./location.mts"
import { Places, buildingAt } from "./places.mts"
import { Gazetteer } from "./gazetteer.mts"
import { createPlaceSearch } from "./search.mts"
import { live, poll } from "../shell/poll.mts"
import { latest } from "../shell/build.mts"
import { TICK_MS, isBusy, now as clock, today, visibleSince } from "../shell/lifecycle.mts"
import { distinct, isSameList, isSameSet, remembered, store, stored } from "../shell/state.mts"
import { HOUR } from "../shared/time.mts"

const VEHICLE_POLL_MS    = 5_000
const PREDICTION_POLL_MS = 30_000
// Predictions older than this, from a poll that's been failing, say nothing about where buses are now
const PREDICTIONS_FRESH_MS = 3 * PREDICTION_POLL_MS

/** The middle of campus, which search prefers the nearer of two places by one name to */
const CAMPUS = { lat: 43.1365, lon: -70.9345 }

// The bundled data, each swapped for a newer build's as it comes, which everything derived from it follows. The
// map works without a model, so it starts with an empty one if its own can't load
export const [feed, model, network, gazetteerData, tiles, style, places] = await Promise.all([
  latest("gtfs", loadFeed),
  latest("model", Model, emptyModel),
  latest("walk", WalkData),
  latest("gazetteer", Gazetteer),
  latest("tiles", TilesManifest),
  latest("style", loadStyle),
  latest("places", Places)
])
const graph = r(() => loadGraph(network.value))
export const gazetteer = r(() => gazetteerData.value.places)
export const buildings = r(() => places.value.buildings)
export const walks = r(() => createWalks(feed.value.stops, graph.value, gazetteer.value))

/** Places by name, laundry and dining first, then the stops buses pick up at, then the rest of Durham */
export const searchPlaces = r(() => {
  const boardable = boardableStops(feed.value)
  return createPlaceSearch([
    ...buildings.value.map(({ lat, lon, name }) => ({ lat, lon, name })),
    ...feed.value.stops.filter((_, i) => boardable.has(i)).map(({ lat, lon, name }) => ({ lat, lon, name })),
    ...gazetteer.value.map(({ name, at: [lon, lat] }) => ({ lat, lon, name }))
  ], CAMPUS)
})

//#region Time

/** The shell's clock in epoch seconds, as the planner compares it with the timetable */
export const now = r(() => clock.value / 1000)

export const runningToday = r(() =>
  new Set(
    feed.value.trips
      .filter(trip => isServiceActive(feed.value.services[trip.service], today.value))
      .map(trip => trip.route)
  )
)

//#endregion

//#region Live data

/** Umo's vehicles as last listed, and how asking for them is going */
const listed = live<Vehicle[]>()
poll(fetchVehicles, VEHICLE_POLL_MS, state => listed.value = state)
/** Every vehicle as Umo last listed it */
const reports = r(() => listed.value.value ?? [])
/** Epoch milliseconds of the last successful vehicles update */
export const lastUpdate = r(() => listed.value.received)
/** Umo's predictions as last answered, for the routes with a bus out */
const asked = live<StopPredictions[]>()
/** What Umo forecasts while its predictions are fresh, and nothing once they've gone stale, so the schedule stands in */
export const forecast = r(() => {
  const { value, received } = asked.value
  return value && received !== undefined && clock.value - received <= PREDICTIONS_FRESH_MS ? forecastOf(value, received / 1000) : NO_FORECAST
})

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

/**
 * Umo has failed to answer from the start, or stopped answering for a while since we've been looking, until it
 * answers again, so that going away and coming back doesn't forget it
 */
export const isLiveDown = r(false)
watch(() => {
  if (lastUpdate.value === undefined ? listed.value.isFailing : silence.value > 3 * VEHICLE_POLL_MS + TICK_MS)
    isLiveDown.value = true
})
watch([listed], () => {
  if (!listed.value.isFailing && listed.value.received !== undefined)
    isLiveDown.value = false
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
    if (route && feed.value.routesById.has(route.id))
      counts.set(route.id, (counts.get(route.id) ?? 0) + 1)
  return counts
})

// Predictions only matter for routes with a bus out; the schedule covers the rest
const predictionPairs = r(() => [
  ...new Map(
    feed.value.trips.flatMap(trip =>
      // Nothing departs a trip's last stop
      trip.stops.slice(0, -1).map(stop => {
        const pair = { route: trip.route, stop: feed.value.stops[stop].id }
        return [`${pair.route}:${pair.stop}`, pair] as const
      })
    )
  ).values()
])

// Keyed by the sorted route ids, so that a new bus going out refreshes right away, and nothing else does
const liveRoutes = distinct(() => [...liveCounts.value.keys()].sort().join(" "))

watch([liveRoutes, predictionPairs], () => {
  const routes = new Set(liveRoutes.value.split(" "))
  const pairs = predictionPairs.value.filter(pair => routes.has(pair.route))
  if (!pairs.length) {
    asked.value = { isFailing: false }
    return
  }
  return poll(signal => fetchPredictions(pairs, signal), PREDICTION_POLL_MS, state => asked.value = state)
})

/** Buses waiting out a layover: their soonest observation is from the schedule, not from them driving */
export const layovers = r(() => {
  const soonest = new Map<string, Observation>()
  for (const observation of forecast.value.observations) {
    const current = soonest.get(observation.vehicleId)
    if (!current || observation.time < current.time)
      soonest.set(observation.vehicleId, observation)
  }
  return new Set([...soonest].filter(([, observation]) => !observation.isLive).map(([id]) => id))
})

/** Every bus with the one you're on where your phone puts it, when riding.mts has it there */
export const fused = r<Fixed[]>()
/** The buses as the map follows them, where the location model has them, and their courses */
export const { followed, sightings } = follow(feed, model, r(() => fused.value ?? vehicles.value))

export const runs = r(() => buildRuns(feed.value, today.value, forecast.value, model.value, sightings.value))

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

// Cards only rerender when something they show changes: the trips, their times to the minute, or how live they are.
// A newer timetable's runs are new objects, so its itineraries come through though they read the same
export const itineraries = distinct(
  (): Itinerary[] => from.value && to.value ? plan(feed.value, walks.value, runs.value, from.value, to.value, now.value) : [],
  (a, b) => a.length === b.length && a.every((itinerary, i) => isSameItinerary(itinerary, b[i]))
)

/** Minutes and meters to walk the whole way, if worth suggesting */
export const walk = r(() => {
  if (!from.value || !to.value)
    return

  const { meters } = walks.value.between(from.value, to.value)
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
    return walkOnly(walks.value, from.value, to.value, now.peek())
  return (
    itineraries.value.find(itinerary => itineraryKey(itinerary) === selected.value) ??
    itineraries.value[0]
  )
})

//#endregion

//#region Map

export const selectedStop = r<number>()

// A newer timetable may number its stops otherwise, so the selected stop is found again in it by its id
let stopsBefore = feed.peek().stops
watch([feed], () => {
  if (feed.value.stops === stopsBefore)
    return
  selectedStop.value = renumbered(selectedStop.peek(), stopsBefore, feed.value.stops)
  stopsBefore = feed.value.stops
})

/** The selected stop's id, reaching what depends on it only when another stop is selected, not as it's renumbered */
export const selectedStopId = distinct(() => {
  const stop = selectedStop.value
  return stop === undefined ? undefined : feed.peek().stops[stop]?.id
})
/** The id of the bus tapped to see its stops */
export const selectedBus = r<string>()
// A ride is over this long after the last word of it, though no bus ride takes nearly as long
const RIDE_MS = 2 * HOUR
/** The bus you're on, by vehicle id, remembered so a reload, as for newer code, doesn't forget it */
export const riding = remembered<string | undefined>("map-riding",
  stored => {
    const { id, at } = Object(stored) as { id?: unknown, at?: unknown }
    return typeof id === "string" && typeof at === "number" && Date.now() - at < RIDE_MS ? id : undefined
  },
  id => id === undefined ? null : { id, at: Date.now() }
)
// Newer code waits until you're off it, as a reload would lose which bus you're on
watch([riding], () => {
  isBusy.value = riding.value !== undefined
})
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

//#endregion

//#region You

const REPLAN_M = 50 // m moved before a trip from or to you is planned again

// The walk from you last measured out, kept while its ends are the same places along the same network, so following
// along it carries on across replans that only freshen the times
let measured: { walks: Walks, from: Place, to: Place, line: Line } | undefined
const lineOf = ({ from, to }: WalkLeg) => {
  if (measured?.from !== from || measured.to !== to || measured.walks !== walks.peek())
    measured = { walks: walks.peek(), from, to, line: toLine(walks.peek().between(from, to).coordinates) }
  return measured.line
}

/** The walk an itinerary starts with from where you are, measured out for following along */
const walkFromYou = (itinerary: Itinerary | undefined) => {
  const leg = itinerary?.legs[0]
  return leg?.kind === "walk" && leg.from.isYou ? lineOf(leg) : undefined
}

/** How far along the walk from where you are you've got, since it was last planned */
export const progress = r<Progress>()

/** Where you are, as a place to plan from, moving only by enough to matter to a plan, or on leaving the walk */
const you = r<Place>()

// Each fix follows you along the walk from you, read without depending on it, as you moving plans that walk again.
// Off it for a few fixes in a row, a new way is planned from where you are, and followed afresh
watch([location], () => {
  const fix = location.value
  if (!fix)
    return
  const line = walkFromYou(itinerary.peek())
  const along = line && walkOn(line, fix, progress.peek())
  const isOff = along !== undefined && isOffPath(along)
  progress.value = isOff ? undefined : along
  const was = you.peek()
  if (!was || isOff || distance(was, fix) >= REPLAN_M)
    you.value = { lat: fix.lat, lon: fix.lon, name: "Your location", isYou: true }
})

// A trip from or to you moves with you, except while you're on a bus, which a plan from where you are would have
// you get off
for (const place of [from, to])
  watch([you, riding], () => {
    if (place.peek()?.isYou && you.value && !riding.peek())
      place.value = you.value
  })

/** A leg's way as the map draws it: a ride's shape, or a walk, which may be a straight line's estimate */
export type LegPath = Pick<Walk, "coordinates" | "via">

/** Each leg of the itinerary as the map draws it, with the walk from you only from where you've got to */
export const legPaths = r((): LegPath[] => {
  const current = itinerary.value
  if (!current)
    return []
  const line = walkFromYou(current)
  const along = progress.value
  return current.legs.map((leg, i) => {
    if (leg.kind === "ride")
      return { coordinates: ridePath(feed.value, leg), via: "network" }
    const walk = walks.value.between(leg.from, leg.to)
    return i === 0 && line
      ? { coordinates: along?.line === line ? sliceLine(line, along.distance, line.length) : line.coordinates, via: walk.via }
      : walk
  })
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
  const building = buildingAt(buildings.peek(), link)
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
