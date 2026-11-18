// What's yours of the events (src/social/saves.mts), kept on every linked device: the sessions you've saved and the
// activities you follow; your class standing, which narrows the registration windows told; the directory of activities
// (src/social/series.mts), which lists fold by; and Yours' events, worked out from saves, follows and Going each time,
// never written back. Reactive values only, no DOM

import { r, type DerivativeNode } from "bruh/reactive"
import * as v from "valibot"
import type { Event, Pin } from "../../social/event.mts"
import { SAVES, SavesFormat, isFollowed, isGoing, isSaved, isYours, setOccurrenceSaved, setSeriesFollowed } from "../../social/saves.mts"
import { type Listing, directory, seriesOf } from "../../social/series.mts"
import { STANDINGS, type Standing } from "../../courses/calendar.mts"
import { distinct, isSameSet, remembered } from "../../shell/state.mts"
import type { MapData } from "./data.mts"

/** How far ahead Yours looks */
const YOURS_MS = 7 * 86_400_000

export const createSaves = ({ events, now, pins }: Pick<MapData, "events"> & { now: DerivativeNode<number>, pins: DerivativeNode<Pin[]> }) => {
  const saves = remembered(SAVES, SavesFormat)
  const standing = remembered<Standing | null>("class-standing", stored => v.is(v.picklist(STANDINGS), stored) ? stored : null)

  // Made again each minute, as sessions end
  const minute = distinct(() => Math.floor(now.value / 60))
  const listings = r((): Listing[] => {
    const data = events.value
    return directory(data.events, data.orgs, minute.value * 60_000)
  })
  const recurringKeys = distinct(() => new Set(listings.value.filter(({ sessions }) => sessions.length).map(({ key }) => key)), isSameSet)

  const listingOf = (key: string | undefined) =>
    key === undefined ? undefined : listings.value.find(listing => listing.key === key)

  /** The activity an event is a session of, if it's listed, which alone is followed */
  const activityOf = (event: Event) =>
    listingOf(seriesOf(event)?.key)

  const isSessionSaved = (event: Event) =>
    isSaved(saves.value, event)

  const isFollowing = (key: string) =>
    isFollowed(saves.value, key)

  const yours = (event: Event | Pin) =>
    isYours(saves.value, event)

  const setSaved = (event: Event, on: boolean) =>
    saves.value = setOccurrenceSaved(saves.peek(), event, on, Date.now())

  const setFollowed = (key: string, on: boolean) =>
    saves.value = setSeriesFollowed(saves.peek(), key, on)

  /** Yours' events for the week ahead, soonest first: each session saved, the next of each activity followed, and each event you're going to */
  const yoursNext = r((): (Event | Pin)[] => {
    const at = now.value * 1000
    const all = [...events.value.events, ...pins.value].filter(event => event.end > at && event.start < at + YOURS_MS)
    const seen = new Set<string>()
    return all.sort((a, b) => a.start - b.start).filter(event => {
      const key = seriesOf(event)?.key
      const next = key !== undefined && isFollowing(key) && !seen.has(key)
      if (next)
        seen.add(key)
      return next || isSessionSaved(event) || isGoing(event)
    })
  })

  return { saves, standing, listings, recurringKeys, listingOf, activityOf, isSessionSaved, isFollowing, yours, setSaved, setFollowed, yoursNext }
}
