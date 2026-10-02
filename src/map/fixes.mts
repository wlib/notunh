// The phone's own position fixes: which to keep, where they put you between fixes, and whether they put you
// on a bus. iOS has already blended GPS, Wi-Fi, and motion into each fix, so they're used as they come rather
// than filtered again, which would only lag behind real turns

import { distance } from "./feed.mts"
import { angleBetween, project, type Coordinates } from "./geometry.mts"

export type Fix = {
  lat: number,
  lon: number,
  /** m, the radius it's likely within */
  accuracy: number,
  /** m/s, if known */
  speed?: number,
  /** Degrees clockwise from north that it's moving, if it is */
  heading?: number,
  /** Epoch milliseconds it was taken */
  at: number
}

// Worse than this is Wi-Fi or cell towers rather than GPS
const POOR = 50 // m
// How long a good fix outranks poor ones that come after it
const GOOD_FOR = 10_000 // ms
// Slower is standing around, with a meaningless heading
export const MIN_SPEED = 1 // m/s
// How long past a fix the dot carries on at its speed, before it waits for the next
const MAX_RECKON = 3_000 // ms

/** Poor fixes, from the phone losing GPS for a moment, are dropped while a good one is recent */
export const isWorthTaking = (last: Fix | undefined, next: Fix) =>
  !last || next.accuracy <= POOR || last.accuracy > POOR || next.at - last.at > GOOD_FOR

/** Where you likely are at a time a little after a fix, carrying on as you were moving */
export const reckon = (fix: Fix, at: number): Coordinates =>
  fix.speed !== undefined && fix.heading !== undefined && fix.speed >= MIN_SPEED
    ? project([fix.lon, fix.lat], fix.heading, fix.speed * Math.min(MAX_RECKON, Math.max(0, at - fix.at)) / 1000)
    : [fix.lon, fix.lat]

// Fixes either side of a time further apart than this don't say where you were in between
const MAX_GAP = 10_000 // ms

/** Where you were at a time, between the fixes either side of it */
export const fixAt = (history: readonly Fix[], at: number): Fix | undefined => {
  const after = history.findIndex(fix => fix.at >= at)
  if (after === -1)
    return
  const [a, b] = [history[Math.max(0, after - 1)], history[after]]
  if (b.at === at)
    return b
  if (b.at - a.at > MAX_GAP || a.at > at)
    return
  const t = b.at === a.at ? 1 : (at - a.at) / (b.at - a.at)
  return { ...b, lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, at }
}

// At the same moment, closer than this is riding the bus, and further is not, with a margin between for GPS
// and the bus's report being off by a second or so
const WITH = 60    // m
const APART = 150  // m
// Moving buses and riders heading further apart than this are going different ways
const MAX_TURN = 60 // degrees

/**
 * Whether you were on a bus when it reported, from where you were at that same moment:
 * "with" it, "apart" from it, or undefined when it's too close to tell
 */
export const compare = (bus: { lat: number, lon: number, heading: number, kph: number }, you: Fix) => {
  const meters = distance(bus, you)
  if (meters > APART)
    return "apart"
  const isTurnedAway =
    bus.kph * 1000 / 3600 >= MIN_SPEED && (you.speed ?? 0) >= MIN_SPEED && you.heading !== undefined &&
    angleBetween(bus.heading, you.heading) > MAX_TURN
  if (meters <= WITH && !isTurnedAway)
    return "with"
}
