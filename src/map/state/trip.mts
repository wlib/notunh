// The trip being planned, from and to where, its itineraries, and you along it: reactive values only, no DOM

import { r, watch } from "bruh/reactive"
import { ridePath } from "../../transit/shapes.mts"
import { type Progress, type Walk, type Walks, isOffPath, walkOn, walkSeconds } from "../../routing/walks.mts"
import { type Itinerary, type WalkLeg, STICKINESS, cost, isSameItinerary, isWalkOffered, plan, planBy, walkBy, walkOnly, wayKey } from "../../routing/plan.mts"
import type { Place } from "../../places/search.mts"
import { buildingAt } from "../../places/buildings.mts"
import { type Line, sliceLine, toLine } from "../../geo/lines.mts"
import { distance } from "../../geo/projection.mts"
import type { MapData } from "./data.mts"
import type { createLocation } from "./location.mts"
import type { createLive } from "./live.mts"
import type { createRiding } from "./riding.mts"
import { today } from "../../shell/lifecycle.mts"
import { type Own, distinct, store, stored } from "../../shell/state.mts"

const isPlace = (value: unknown): value is Place => {
  const { lat, lon, name }: { lat?: unknown, lon?: unknown, name?: unknown } = Object(value)
  return typeof lat === "number" && typeof lon === "number" && typeof name === "string"
}

// The trip being planned is kept for the rest of the day, so the page reloading, as it does after a while away,
// picks it back up
const TRIP = "map-trip"
const REPLAN_M = 50 // m moved before a trip from or to you is planned again

/** A leg's way as the map draws it: a ride's shape, or a walk, which may be a straight line's estimate */
export type LegPath = Pick<Walk, "coordinates" | "via">

/**
 * The trip being planned, from and to where, its itineraries, and you along it, kept for the rest of the day. A link
 * to a building in the page's address plans a trip there. own is given what stops it
 */
export const createTrip = (
  { feed, walks, buildings, now, runs, riding, location, currentLocation, locationProblem }:
    MapData & ReturnType<typeof createLocation> & ReturnType<typeof createLive> & ReturnType<typeof createRiding>,
  own: Own
) => {
  const trip: { day?: unknown, from?: unknown, to?: unknown, by?: unknown, selected?: unknown } = Object(stored(TRIP))
  const isTripToday = trip.day === today.peek()

  const from = r(isTripToday && isPlace(trip.from) ? trip.from : undefined)
  const to = r(isTripToday && isPlace(trip.to) ? trip.to : undefined)
  /** Epoch seconds to get there by, or undefined to leave now and get there soonest. One kept that's already past is no time to plan for */
  const by = r(isTripToday && typeof trip.by === "number" && trip.by > now.peek() ? trip.by : undefined)
  /** The wayKey of the chosen itinerary, which stays chosen as its times change and as you walk, or "walk" */
  const selected = r(isTripToday && typeof trip.selected === "string" ? trip.selected : undefined)
  own(watch(() => {
    store(TRIP, { day: today.peek(), from: from.value, to: to.value, by: by.value, selected: selected.value })
  }))

  /**
   * The ways there by bus from a place to another, as of now: the best leaving now, or with a time to get there by,
   * the best that make it, else, as none does, the best leaving now. Those `shown` last time keep their place while
   * they hold up
   */
  const plansFor = (from: Place, to: Place, by: number | undefined, shown: Itinerary[] = []): Itinerary[] => {
    const inTime = by === undefined ? [] : planBy(feed.value, walks.value, runs.value, from, to, by, now.value, shown)
    return inTime.length ? inTime : plan(feed.value, walks.value, runs.value, from, to, now.value, shown)
  }

  /** Walking the whole way, leaving now, or with a time to get there by, so as to be there then, its allowance left */
  const walkingTo = (from: Place, to: Place, by: number | undefined) =>
    by === undefined ? walkOnly(walks.value, from, to, now.peek()) : walkBy(walks.value, from, to, by)

  /** The options last planned, and for which trip, which stay shown while they hold up as the forecast shifts, and whether the walk led them */
  let shown: { from?: Place, to?: Place, by?: number, options: Itinerary[], isWalkFirst?: boolean } = { options: [] }

  // Cards only rerender when something they show changes: the trips, their times to the minute, or how live they are.
  // A newer timetable's runs are new objects, so its itineraries come through though they read the same
  const itineraries = distinct(
    (): Itinerary[] => {
      if (!from.value || !to.value)
        return []
      const isSameTrip = shown.from === from.value && shown.to === to.value && shown.by === by.value
      const options = plansFor(from.value, to.value, by.value, isSameTrip ? shown.options : [])
      shown = { from: from.value, to: to.value, by: by.value, options, isWalkFirst: isSameTrip ? shown.isWalkFirst : undefined }
      return options
    },
    (a, b) => a.length === b.length && a.every((itinerary, i) => isSameItinerary(itinerary, b[i]))
  )

  /** Whether the ways shown get there by the time asked, which with none asked they do */
  const makesIt = r(() => by.value === undefined || itineraries.value.some(itinerary => itinerary.end <= by.value!))

  /** Minutes and meters to walk the whole way, if worth suggesting, and whether it feels better than the best bus, to go first */
  const walk = r(() => {
    if (!from.value || !to.value)
      return

    const { meters } = walks.value.between(from.value, to.value)
    const seconds = walkSeconds(meters)
    const [best] = itineraries.value
    // Short walks, walks not much longer than the bus, or the only option
    const isWorthIt =
      !best ||
      isWalkOffered(seconds) ||
      seconds <= 1.5 * (best.end - best.start)
    if (!isWorthIt)
      return
    // Leading while it feels better than the best bus, and once leading or not, until that changes by STICKINESS
    const walking = cost(walkingTo(from.value, to.value, by.value), now.value, by.value)
    const isFirst = !best || walking + (shown.isWalkFirst === undefined ? 0 : shown.isWalkFirst ? -STICKINESS : STICKINESS) < cost(best, now.value, by.value)
    shown.isWalkFirst = isFirst
    return { minutes: Math.max(1, Math.round(seconds / 60)), meters, isFirst }
  })

  const itinerary = r((): Itinerary | undefined => {
    if (selected.value === "walk" && from.value && to.value)
      return walkingTo(from.value, to.value, by.value)
    return (
      itineraries.value.find(itinerary => wayKey(itinerary) === selected.value) ??
      itineraries.value[0]
    )
  })

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
  const progress = r<Progress>()

  /** Where you are, as a place to plan from, moving only by enough to matter to a plan, or on leaving the walk */
  const you = r<Place>()

  // Each fix follows you along the walk from you. The itinerary is read without depending on it, as you moving replans
  // that walk. Off it for a few fixes in a row, a new way is planned from where you are, and followed afresh
  own(watch([location], () => {
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
  }))

  // A trip from or to you moves with you, except while you're on a bus, which a plan from where you are would have
  // you get off
  for (const place of [from, to])
    own(watch([you, riding], () => {
      if (place.peek()?.isYou && you.value && !riding.peek())
        place.value = you.value
    }))

  /** Each leg of the itinerary as the map draws it, with the walk from you only from where you've got to */
  const legPaths = r((): LegPath[] => {
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

  const isLocating = r(false)

  /** The current location as a place, or undefined with locationProblem saying why, unless quiet */
  const useCurrentLocation = async ({ quiet = false } = {}): Promise<Place | undefined> => {
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
  const directTo = async (place: Place) => {
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
  /** Settled once where you are has been looked for, or found not to be allowed, so a trip from you can be planned */
  const located = (navigator.permissions?.query({ name: "geolocation" }) ?? Promise.reject())
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

  return { from, to, by, selected, itineraries, makesIt, walk, itinerary, progress, legPaths, isLocating, located, useCurrentLocation, directTo, plansFor, walkingTo }
}
