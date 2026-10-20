// The static schedule, converted from GTFS by scripts/map/convert.mts

import * as v from "valibot"
import { arrayOf, objectOf, readJson } from "../shared/json.mts"
import { Day, HOUR, addDays, localDay, offsetAt, weekday } from "../shared/time.mts"

export type Route = {
  id:    string,
  name:  string,
  long:  string,
  color: string,
  /** Readable on color: GTFS's route_text_color unless it has too little contrast */
  text:  string
}

export type Stop = {
  id:   string,
  name: string,
  lat:  number,
  lon:  number
}

export type Service = {
  /** Bitmask of weekdays, Monday = 1 << 0 */
  days:    number,
  /** The first and last days it runs, or "" for a service that only runs on added days */
  start:   Day,
  end:     Day,
  added:   Day[],
  removed: Day[]
}

export type Trip = {
  id:       string,
  route:    string,
  service:  string,
  headsign: string,
  shape:    string,
  /** Indices into FeedData.stops */
  stops:    number[],
  /** Seconds since the start of the service day that the bus leaves each stop, aligned with stops */
  times:    number[],
  /** When it gets to each stop, only for trips that get to some stop before they leave it */
  arrivals?: number[],
  /** Positions in stops where nobody can get on, and where nobody can get off, like "Arrivals Only" stops */
  noPickup?:  number[],
  noDropOff?: number[],
  /** Positions in stops where the bus waits for its scheduled time before going on, which the connectors don't */
  timepoints: number[]
}

/** The JSON written at build time, by its version and the days it runs, its contents taken on trust */
export const FeedData = v.object({
  version:  v.string(),
  start:    Day,
  end:      Day,
  routes:   arrayOf<Route>(),
  stops:    arrayOf<Stop>(),
  services: objectOf<Record<string, Service>>(),
  trips:    arrayOf<Trip>(),
  shapes:   objectOf<Record<string, [number, number][]>>()
})
export type FeedData = v.InferOutput<typeof FeedData>

export type Feed = FeedData & {
  routesById: ReadonlyMap<string, Route>
}

/** A route's short name, or the capitals of its id, like "WE" for WestEdge */
export const routeLabel = (route: Route) =>
  route.name.length <= 3
    ? route.name
    : route.id.match(/[A-Z]/g)?.join("") ?? route.id[0]

export const withIndexes = (data: FeedData): Feed => ({
  ...data,
  routesById: new Map(data.routes.map(route => [route.id, route]))
})

export const loadFeed = (response: Response) =>
  readJson(response, FeedData).then(withIndexes)

/** Seconds into the service day a trip gets to a stop, which is when it leaves unless it waits there */
export const arrivalTime = (trip: Trip, position: number) =>
  (trip.arrivals ?? trip.times)[position]

/** Whether anyone can get on at a position of a trip, which nobody can at its last stop */
export const canBoard = (trip: Trip, position: number) =>
  position + 1 < trip.stops.length && !trip.noPickup?.includes(position)

/** Whether anyone can get off at a position of a trip, which nobody can at its first stop */
export const canAlight = (trip: Trip, position: number) =>
  position > 0 && !trip.noDropOff?.includes(position)

/** The stops somebody can get on a bus at */
export const boardableStops = (feed: FeedData) =>
  new Set(feed.trips.flatMap(trip => trip.stops.filter((_, position) => canBoard(trip, position))))

/** A stop, by its index among some stops, as its index among others, found by its id, or undefined if it's gone */
export const renumbered = (stop: number | undefined, before: readonly Stop[], after: readonly Stop[]) => {
  const id = stop === undefined ? undefined : before[stop]?.id
  const index = after.findIndex(other => other.id === id)
  return index < 0 ? undefined : index
}

/**
 * GTFS times count from "noon minus 12h" so they stay correct across DST changes
 * @returns epoch milliseconds that the service day's times are relative to
 */
export const serviceDayStart = (day: Day) => {
  const noon = Date.parse(`${day}T12:00:00Z`)
  return noon - offsetAt(noon) - 12 * HOUR
}

/** Epoch seconds a trip's times count from, on whichever service day running it is nearest a time */
export const tripBase = (feed: FeedData, trip: Trip, at: number) => {
  const today = localDay(at * 1000)
  const offset = (base: number) =>
    Math.max(0, base + trip.times[0] - at, at - base - trip.times.at(-1)!)
  return [addDays(today, -1), today]
    .filter(day => isServiceActive(feed.services[trip.service], day))
    .map(day => serviceDayStart(day) / 1000)
    .sort((a, b) => offset(a) - offset(b))[0] as number | undefined
}

export const isServiceActive = (service: Service | undefined, day: Day) => {
  if (!service || service.removed.includes(day))
    return false
  if (service.added.includes(day))
    return true

  return (
    day >= service.start &&
    day <= service.end &&
    (service.days & (1 << weekday(day))) !== 0
  )
}

