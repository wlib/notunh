// Parking on the map: UNH's parking areas (src/parking/), loaded with the page as its head names them
// (state/data.mts), as small as the courses' index; UNH's holidays, from that index's calendar; and your permit,
// synced with your other things (src/shell/sync.mts). Reactive values only, no DOM

import * as v from "valibot"
import { r } from "bruh/reactive"
import { type Purpose, type Stay, Permit } from "../../parking/model.mts"
import type { Visit } from "../../shared/visit.mts"
import { HOUR } from "../../shared/time.mts"
import { remembered } from "../../shell/state.mts"
import type { MapData } from "./data.mts"

/** Where your permit is kept, as the Permit it is, or null for none */
const PERMIT = "parking-permit"

/** How long before a class or an event to park by, to walk there, and how long after it ends to be gone by */
export const EARLY = 30 * 60_000
export const AFTER = 15 * 60_000
/** How long a stay is that's asked for without one, from now */
export const STAY = 2 * HOUR

/** A stay from a minute, to the minute, for two hours: what a page asks for with no stay of its own */
export const defaultStay = (now: number): Stay => {
  const from = Math.floor(now / 60_000) * 60_000
  return { from, to: from + STAY }
}

/** The stay to park for a visit: from a little before it's there by, to a little after it ends, or two hours where that isn't known */
export const stayOfVisit = (visit: Pick<Visit, "arriveBy" | "offset" | "until">): Stay => {
  const from = visit.arriveBy - visit.offset - EARLY
  return { from, to: visit.until !== undefined && visit.until > from ? visit.until + AFTER : from + STAY }
}

/** What a visit's parking is for: a class's, an event's, or a visit, as to a place */
export const purposeOfVisit = (visit: Pick<Visit, "occurrence">): Purpose =>
  visit.occurrence?.id.startsWith("course:") ? "class" : visit.occurrence ? "event" : "visit"

/** A permit as stored, or none for anything else */
export const readPermit = (stored: unknown): Permit | undefined =>
  v.is(Permit, stored) ? stored : undefined

export const createParkingState = ({ coursesIndex }: Pick<MapData, "coursesIndex">) => {
  /** UNH's holidays, when its permits aren't checked and its meters are free */
  const holidays = r(() => coursesIndex.value.calendar.holidays)

  const permit = remembered<Permit | undefined>(PERMIT, readPermit, value => value ?? null)

  return { holidays, permit }
}
