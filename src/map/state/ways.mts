// The itineraries shown grouped by the way they go, so the same way at other times is a line under one card rather
// than a card each. The planner's options and their ranking are left as they are (src/routing/plan.mts)

import { type Itinerary, walkKey } from "../../routing/plan.mts"
import { groupBy } from "../../shared/group.mts"

/**
 * Identifies the way an itinerary goes whichever buses it catches: the routes it rides, the stops it gets on and off
 * at, and the places it walks between. Unlike wayKey, departures of the same way at other times share it
 */
export const patternKey = (itinerary: Itinerary) =>
  itinerary.legs
    .map(leg => {
      if (leg.kind === "walk")
        return walkKey(leg)
      const { trip } = leg.run
      return `${trip.route}:${trip.stops[leg.fromPosition]}-${trip.stops[leg.toPosition]}`
    })
    .join(" ")

/** Itineraries ranked best first, grouped by the way they go, each group best first and in the order of its best */
export const byPattern = (itineraries: Itinerary[]) =>
  [...groupBy(itineraries, patternKey).values()]

/** The departures of a way other than the one shown, soonest first */
export const othersOf = (departures: Itinerary[], shown: Itinerary) =>
  departures.filter(departure => departure !== shown).sort((a, b) => a.start - b.start)
