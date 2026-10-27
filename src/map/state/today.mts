// Today on the map: the official events the build bundled and the public pins the Worker lists, as one list of
// events (src/social/event.mts), and those with a place the map knows and a time as pins to draw: a pin whose time is
// still to pick is listed, but isn't anywhere at any time yet (src/social/marks.mts). Reactive values only, no DOM

import { r, watch } from "bruh/reactive"
import type { DerivativeNode } from "bruh/reactive"
import { type Event, type EventsData, type Pin, placeOf, today as todayOf } from "../../social/event.mts"
import { isUnset } from "../../social/marks.mts"
import * as api from "../../social/browser/api.mts"
import type { Place } from "../../places/search.mts"
import type { MapData } from "./data.mts"
import { today } from "../../shell/lifecycle.mts"
import type { Own } from "../../shell/state.mts"

/** An event with the place the map puts it at */
export type Placed = { event: Event, place: Place }

export const createToday = ({ events, gazetteer, now }: Pick<MapData, "events" | "gazetteer"> & { now: DerivativeNode<number> }, own: Own) => {
  /** The public pins the Worker lists for today, as last heard; none until it answers, and none while offline */
  const listed = r<Pin[]>([])

  /** Asks the Worker for today's public pins, keeping what it had if that fails */
  const refresh = () =>
    api.pinsOn(today.peek()).then(pins => listed.value = pins, () => {})

  // Once as the map loads, and again each day
  own(watch([today], () => void refresh()))

  /** Everything on today, soonest first: the build's events and the pins listed, those long over left out */
  const list = r((): (Event | Pin)[] => todayOf<Event | Pin>([...(events.value as EventsData).events, ...listed.value], now.value * 1000))

  /** Those with a time, and a place the map knows, where the map draws them */
  const placed = r((): Placed[] => list.value.flatMap(event => {
    const place = isUnset(event) ? undefined : placeOf(gazetteer.value, event.place)
    return place ? [{ event, place }] : []
  }))

  return { todayList: list, todayPlaced: placed, refreshPins: refresh }
}
