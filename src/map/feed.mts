// The static schedule, converted from GTFS by scripts/map/convert.mts

import { getJson } from "../shared/json.mts"
import { type Day, HOUR, addDays, localDay, offsetAt, weekday } from "../shared/time.mts"

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
  lon:  number,
  /** Present only for stops where nobody can board, like "Arrivals Only" stops */
  pickup?: false
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
  /** Seconds since the start of the service day, aligned with stops */
  times:    number[],
  /** Positions in stops where the bus waits for its scheduled time before going on, which the connectors don't */
  timepoints: number[]
}

/** The JSON written at build time */
export type FeedData = {
  version:  string,
  start:    Day,
  end:      Day,
  routes:   Route[],
  stops:    Stop[],
  services: Record<string, Service>,
  trips:    Trip[],
  shapes:   Record<string, [number, number][]>
}

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

export const loadFeed = (url: string) =>
  getJson<FeedData>(url).then(withIndexes)

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

/** Meters between two points, as the crow flies */
export const distance = (a: { lat: number, lon: number }, b: { lat: number, lon: number }) => {
  const toRadians = Math.PI / 180
  const x = (b.lon - a.lon) * toRadians * Math.cos((a.lat + b.lat) / 2 * toRadians)
  const y = (b.lat - a.lat) * toRadians
  return Math.hypot(x, y) * 6_371_000
}
