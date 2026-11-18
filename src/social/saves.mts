// What's yours of the events, by what you tapped: a session saved is that session alone, let go once it's over; an
// activity followed (series.mts) is kept by its key, so it outlasts weeks with nothing posted. Neither is inferred from
// the other. Going stays the Worker's, on people's own events (event.mts). Kept as one synced key (src/shared/sync.mts),
// which your calendar feed reads the saved sessions from. Pure

import * as v from "valibot"
import { type Event, type Pin, LINGER } from "./event.mts"
import { seriesOf } from "./series.mts"
import { format } from "../shared/format.mts"

/** The synced key saves are kept under */
export const SAVES = "events-saved"

export const Saves = v.object({
  /** Sessions saved, by the id they were saved by, each with when it ends, so it's let go once over */
  sessions: v.record(v.string(), v.number()),
  /** Activities followed, by their series' key */
  follows:  v.array(v.string())
})
export type Saves = v.InferOutput<typeof Saves>

export const NO_SAVES: Saves = { sessions: {}, follows: [] }

/** Saves as kept, or none for anything else */
export const readSaves = (stored: unknown): Saves =>
  v.is(Saves, stored) ? stored : NO_SAVES

/** How saves are read wherever they're kept, by the page and by the Worker for your feed (src/shared/format.mts) */
export const SavesFormat = format(readSaves)

/** The id an event was saved by, if it's saved: its own, or any it's also told by, so a merge keeps the save */
export const savedId = (saves: Saves, event: Pick<Event, "id" | "also">) =>
  [event.id, ...event.also ?? []].find(id => Object.hasOwn(saves.sessions, id))

export const isSaved = (saves: Saves, event: Pick<Event, "id" | "also">) =>
  savedId(saves, event) !== undefined

export const isFollowed = (saves: Saves, key: string) =>
  saves.follows.includes(key)

export const isGoing = (event: Event | Pin) =>
  "isGoing" in event && event.isGoing === true

/** Whether an event is yours: saved, a session of an activity followed, or one you're going to */
export const isYours = (saves: Saves, event: Event | Pin) =>
  isSaved(saves, event) || isFollowed(saves, seriesOf(event)?.key ?? "") || isGoing(event)

/** Saves with those over as of now let go */
export const pruned = (saves: Saves, now: number): Saves =>
  ({ ...saves, sessions: Object.fromEntries(Object.entries(saves.sessions).filter(([, end]) => end + LINGER > now)) })

export const setOccurrenceSaved = (saves: Saves, event: Event, on: boolean, now: number): Saves => {
  const kept = pruned(saves, now)
  const ids = [event.id, ...event.also ?? []]
  const sessions = Object.fromEntries(Object.entries(kept.sessions).filter(([id]) => !ids.includes(id)))
  return { ...kept, sessions: on ? { ...sessions, [savedId(kept, event) ?? event.id]: event.end } : sessions }
}

export const setSeriesFollowed = (saves: Saves, key: string, on: boolean): Saves =>
  ({ ...saves, follows: on ? [...new Set([...saves.follows, key])] : saves.follows.filter(followed => followed !== key) })
