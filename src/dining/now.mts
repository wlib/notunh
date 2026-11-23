// What dining is doing now, as the map's home says it in Today, in Campus and in its search (src/map/ui/Campus.tsx):
// the halls open, those about to, and the next to open where none is. From each hall's standing alone (hours.mts),
// worked out for the same minute, so it holds for any clock. The menus carry no meal times, nor does any page of UNH
// Dining's, so a hall's standing is its hours, and the meal it's serving is the one its clock hour is for

import { type Status, type WallTime, wallDate } from "./hours.mts"

/** Minutes before a hall opens that it counts as about to, which Today shows it for */
export const SOON_MINUTES = 60

/** A hall with how it stands, where its hours are known */
type Standing = { standing?: Status }

/** A hall open now */
export type Open<H extends Standing> = H & { standing: Extract<Status, { isOpen: true }> }

export type DiningNow<H extends Standing> = {
  /** The halls open now, in their own order */
  open:    Open<H>[],
  /** The halls open now or opening within the hour, in their own order, which Today shows */
  serving: H[],
  /** The closed hall that opens soonest, and when, within the week its hours reach */
  next?:   { hall: H, opens: WallTime }
}

/** Minutes from one wall time to another */
export const minutesBetween = (from: WallTime, to: WallTime) =>
  (wallDate(to).getTime() - wallDate(from).getTime()) / 60_000

const isOpen = <H extends Standing,>(hall: H): hall is Open<H> =>
  hall.standing?.isOpen === true

const opensOf = ({ standing }: Standing) =>
  standing && !standing.isOpen ? standing.opens : undefined

/** What dining is doing at a minute, from each hall's standing then */
export const diningNow = <H extends Standing,>(halls: H[], now: WallTime): DiningNow<H> => {
  const isSoon = (hall: H) => {
    const opens = opensOf(hall)
    return opens !== undefined && minutesBetween(now, opens) <= SOON_MINUTES
  }
  const next = halls
    .flatMap(hall => {
      const opens = opensOf(hall)
      return opens ? [{ hall, opens }] : []
    })
    .reduce<DiningNow<H>["next"]>((soonest, hall) => !soonest || minutesBetween(hall.opens, soonest.opens) > 0 ? hall : soonest, undefined)
  return {
    open:    halls.filter(isOpen),
    serving: halls.filter(hall => isOpen(hall) || isSoon(hall)),
    ...next && { next }
  }
}

/**
 * The clock hour whose meal a hall serves now or next: now's while it's open, its opening's where it opens later
 * today, and else now's, as a menu is for the day it's read
 */
export const mealHour = (standing: Status | undefined, now: WallTime) => {
  const opens = standing && !standing.isOpen ? standing.opens : undefined
  return Math.floor((opens?.day === now.day ? opens.minute : now.minute) / 60)
}
