// A visit: going somewhere by a time, a few minutes early if you like. It's what Directions plans and what Remind
// reminds, and needs nothing saved, joined or told. An occurrence (an event, a dated class meeting) is a row to list
// and route to; a visit is what a person makes of one, or of a place and a time they pick. The destination is a
// gazetteer name, the building, with where in it as written, like "N343" or "behind the MUB", so a room change is a
// change of visit. Instants are epoch milliseconds, as an occurrence's are

import * as v from "valibot"

/** ms before its time a visit asks to be there by, to choose from: at the start, 5 or 10 minutes before */
export const OFFSETS = [0, 300_000, 600_000]

export const Visit = v.object({
  destination: v.object({ place: v.string(), where: v.string() }),
  /** Epoch ms it starts, which is what it's to be there by, less the offset */
  arriveBy:    v.number(),
  offset:      v.number(),
  /** Epoch ms it ends, where that's known, as of a class or an event, which is how long parking for it is for */
  until:       v.optional(v.number()),
  /** What it's a visit to, kept on the phone alone, to say so: an event's id and title, or a class's */
  occurrence:  v.optional(v.object({ id: v.string(), title: v.string() }))
})
export type Visit = v.InferOutput<typeof Visit>

/**
 * An occurrence: anything that happens at a place from a start to an end, which lists as a row, marks the map, and
 * is routed to. The Event shape (src/social/event.mts) is one, and a dated class meeting projects to one
 * (src/courses/course.mts); a section, an instructor and a parking area never are
 */
export type Occurrence = { id: string, title: string, start: number, end: number, place?: string, where: string }

/** A visit to an occurrence, there by its start less the offset, or none for one at no place the map knows */
export const visitOf = ({ id, title, start, end, place, where }: Occurrence, offset = 0): Visit | undefined =>
  place === undefined ? undefined : { destination: { place, where }, arriveBy: start, offset, until: end, occurrence: { id, title } }

/** Epoch ms to be there by */
export const thereBy = ({ arriveBy, offset }: Pick<Visit, "arriveBy" | "offset">) =>
  arriveBy - offset

/**
 * The planner's query for a visit, as of epoch ms `now`: to its place, to be there by its time less its offset, in
 * the planner's epoch seconds, or leaving now once that's come
 */
export const queryOf = (visit: Visit, now: number) =>
  ({ place: visit.destination.place, by: thereBy(visit) > now ? thereBy(visit) / 1000 : undefined })

/** Whether two visits are to the same occasion, whatever the offset: the same place and room at the same time */
export const isSameOccasion = (a: Visit, b: Visit) =>
  a.destination.place === b.destination.place && a.destination.where === b.destination.where && a.arriveBy === b.arriveBy
