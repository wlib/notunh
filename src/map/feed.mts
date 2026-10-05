// The static schedule, converted from GTFS by scripts/map/convert.mts

import { TIME_ZONE, localDay } from "../shell/time.mts"

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
  start:   number,
  end:     number,
  added:   number[],
  removed: number[]
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
  start:    number,
  end:      number,
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

export const loadFeed = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`Failed to load schedule: ${response.status}`)
  return withIndexes(await response.json())
}

const offsetFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  timeZoneName: "longOffset"
})

/** The local calendar date as YYYYMMDD */
export const localDate = (ms: number) =>
  +localDay(ms).replaceAll("-", "")

const dateToUtc = (date: number, hours = 0) =>
  Date.UTC(Math.floor(date / 10000), Math.floor(date / 100) % 100 - 1, date % 100, hours)

export const addDays = (date: number, days: number) => {
  const utc = new Date(dateToUtc(date) + days * 86_400_000)
  return utc.getUTCFullYear() * 10000 + (utc.getUTCMonth() + 1) * 100 + utc.getUTCDate()
}

/**
 * GTFS times count from "noon minus 12h" so they stay correct across DST changes
 * @returns epoch milliseconds that the service day's times are relative to
 */
export const serviceDayStart = (date: number) => {
  const noonUtc = dateToUtc(date, 12)
  const offset = offsetFormat.format(noonUtc).match(/GMT([+-])(\d+):(\d+)/)
  const offsetMs =
    offset
      ? (offset[1] === "-" ? -1 : 1) * (+offset[2] * 60 + +offset[3]) * 60_000
      : 0
  return noonUtc - offsetMs - 12 * 3600_000
}

export const isServiceActive = (service: Service | undefined, date: number) => {
  if (!service || service.removed.includes(date))
    return false
  if (service.added.includes(date))
    return true

  const weekday = (new Date(dateToUtc(date)).getUTCDay() + 6) % 7
  return (
    date >= service.start &&
    date <= service.end &&
    (service.days & (1 << weekday)) !== 0
  )
}

/** Meters between two points, as the crow flies */
export const distance = (a: { lat: number, lon: number }, b: { lat: number, lon: number }) => {
  const toRadians = Math.PI / 180
  const x = (b.lon - a.lon) * toRadians * Math.cos((a.lat + b.lat) / 2 * toRadians)
  const y = (b.lat - a.lat) * toRadians
  return Math.hypot(x, y) * 6_371_000
}
