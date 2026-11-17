// Your calendars on the map: those you've imported (src/courses/imported.mts), kept on this device alone, each event
// matched to the section it's a meeting of and the place it's at once the courses have loaded, for the week in You
// and the next of them in Yours; and the address of your own feed, of your saved sections and the events you're
// going to (worker/calendar.mts), by a token made the first time it's asked for and kept as one of your things, so
// your other devices share it. Reactive values only, no DOM

import { type DerivativeNode, r } from "bruh/reactive"
import { addressOf, fetchCalendar, readCalendar } from "../../courses/browser/calendars.mts"
import type { Courses } from "../../courses/browser/terms.mts"
import { type DatedImport, type Kept, type Match, KEY, STALE_MS, createMatcher, importedOn, keptOf, readKept, withKept } from "../../courses/imported.mts"
import { placeMatcher } from "../../social/aliases.mts"
import { calendarPath } from "../../social/calendar.mts"
import { placeNames } from "../../social/event.mts"
import { randomBase64Url } from "../../shared/base64url.mts"
import { FEED, FeedToken } from "../../shared/sync.mts"
import { loadTemporal } from "../../shared/temporal.mts"
import type { Day } from "../../shared/time.mts"
import * as v from "valibot"
import { today } from "../../shell/lifecycle.mts"
import { remembered, syncing } from "../../shell/state.mts"
import { sync } from "../../shell/sync.mts"
import type { MapData } from "./data.mts"

/** An imported event on a day, with what it's matched to */
export type Imported = DatedImport & { match: Match }

/** How many days from today the next imported event is looked for */
const AHEAD = 7

export const createCalendars = ({ gazetteer, courses, wantCourses, now }: Pick<MapData, "gazetteer"> & { courses: DerivativeNode<Courses | undefined>, wantCourses: () => void, now: DerivativeNode<number> }) => {
  const calendars = remembered<Kept[]>(KEY, readKept)

  /** Whether Temporal is here, which an event's days are asked through: loaded once there's a calendar to read */
  const isReady = r(false)
  const ready = () =>
    loadTemporal().then(() => void (isReady.value = true))
  // Matching reads the courses, which anyone with a calendar here wants
  if (calendars.peek().length) {
    wantCourses()
    ready().catch(() => {})
  }

  const matcher = r(() => {
    const live = courses.value
    return live && createMatcher(live.terms, live.calendar, placeMatcher(placeNames(gazetteer.value)))
  })

  /** The imported events starting on some Durham days from one, soonest first, each matched once the courses have loaded */
  const importsOn = (from: Day, days: number): Imported[] =>
    isReady.value ? importedOn(calendars.value.flatMap(({ events }) => events), from, days).map(dated => ({ ...dated, match: matcher.value?.(dated.event, from) ?? {} })) : []

  /** The coming days' imported events, read once a day, and the next of them not yet over, for Yours */
  const coming = r(() => importsOn(today.value, AHEAD))
  const nextImport = r(() => coming.value.find(({ end }) => end > now.value * 1000))

  const keep = (one: Kept) => {
    calendars.value = withKept(calendars.peek(), one)
    wantCourses()
    return one
  }

  /** Imports a calendar from its address or a file, or rejects saying why not */
  const importCalendar = async (from: { url: string } | { file: File }) => {
    await ready()
    if ("file" in from)
      return keep(keptOf(await readCalendar(from.file), { name: from.file.name.replace(/\.ics$/i, "") }, Date.now()))
    const url = addressOf(from.url)
    if (!url)
      throw new Error("That isn't a calendar's link.")
    return keep(keptOf(await fetchCalendar(url.href), { url: url.href, name: url.hostname }, Date.now()))
  }

  const forgetCalendar = (id: string) =>
    calendars.value = calendars.peek().filter(other => other.id !== id)

  /** Reads again the calendars with an address that were read a while ago, keeping what's here where one can't be read */
  const refreshCalendars = () =>
    ready().then(() => Promise.all(calendars.peek().filter(({ url, at }) => url && Date.now() - at > STALE_MS).map(({ url, name }) =>
      fetchCalendar(url!).then(ics => keep(keptOf(ics, { url, name }, Date.now())), () => {}))), () => {})

  /** Your feed's token, once it's been asked for here or on another device of yours, and whether the Worker has it yet */
  const feedToken = remembered<string | null>(FEED, stored => v.is(FeedToken, stored) ? stored : null)
  const isFeedKept = r(!syncing().pending.includes(FEED))
  const feedPath = r(() => isFeedKept.value && feedToken.value ? calendarPath("feed", feedToken.value) : null)

  /**
   * Makes your feed's token, anew where there's one, which ends the old address, and gives its address out only once
   * the Worker has it, so no calendar asks by it too soon: sent now, and once more where an exchange already under
   * way went without it
   */
  const makeFeed = async () => {
    isFeedKept.value = false
    feedToken.value = randomBase64Url(16)
    await sync()
    if (syncing().pending.includes(FEED))
      await sync()
    if (syncing().pending.includes(FEED))
      throw new Error("Couldn't reach notunh.")
    isFeedKept.value = true
    return calendarPath("feed", feedToken.peek()!)
  }

  return { calendars, importsOn, nextImport, importCalendar, forgetCalendar, refreshCalendars, feedPath, makeFeed }
}
