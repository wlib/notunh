// The trip being planned, from and to where, its itineraries, and you along it: reactive values only, no DOM

import { r, watch } from "bruh/reactive"
import { ridePath } from "../../transit/shapes.mts"
import { type Progress, type Walk, type Walks, isOffPath, walkOn, walkSeconds } from "../../routing/walks.mts"
import { type Itinerary, type WalkLeg, isSameItinerary, itineraryKey, plan, walkOnly } from "../../routing/plan.mts"
import type { Place } from "../../places/search.mts"
import { buildingAt } from "../../places/buildings.mts"
import { type Line, sliceLine, toLine } from "../../geo/lines.mts"
import { distance } from "../../geo/projection.mts"
import { buildings, feed, walks } from "./data.mts"
import { now, runs } from "./live.mts"
import { riding } from "./riding.mts"
import { currentLocation, location, locationProblem } from "./location.mts"
import { today } from "../../shell/lifecycle.mts"
import { distinct, store, stored } from "../../shell/state.mts"

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

// Each fix follows you along the walk from you. The itinerary is read without depending on it, as you moving replans
// that walk. Off it for a few fixes in a row, a new way is planned from where you are, and followed afresh
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
// to the building, replacing any trip kept from earlier. The link is then dropped from the URL, so a reload keeps the
// trip as you've changed it since. Links to anywhere unknown are ignored
const link = new URLSearchParams(globalThis.location.search).get("to")
if (link !== null) {
  history.replaceState(history.state, "", globalThis.location.pathname)
  const building = buildingAt(buildings.peek(), link)
  if (building) {
    from.value = undefined
    directTo({ lat: building.lat, lon: building.lon, name: building.name })
  }
}

// Start from the current location if the user already allowed it. Otherwise don't keep a trip from or to where you
// were, as there's no following you from there. Browsers without the permissions API keep it until you next locate
// yourself
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
