/** @jsxImportSource bruh/browser */

// What's ahead: the academic calendar's deadlines, registration windows, breaks and term dates
// (src/courses/calendar.mts), home games, one-off events from UNH's pages, and what's yours further out. The home
// shows three rows at most: one of yours, one for everyone and one public event. The term is a page of its own, by
// month, its registration windows narrowed to your class standing and its games only those you've saved, as the rest
// are Athletics' schedule, not a plan. Dates in the next few days join Yours

import { r } from "bruh/reactive"
import type { Event } from "../../social/event.mts"
import { isGoing } from "../../social/saves.mts"
import { groupBy } from "../../shared/group.mts"
import { STANDINGS, type KeyDate, type Standing } from "../../courses/calendar.mts"
import { type Day as CalendarDay, addDays, localDay } from "../../shared/time.mts"
import { Day } from "../../shell/intl.tsx"
import { state } from "../state/map.mts"
import { nowMs } from "./common.tsx"
import { EventRow, Head, Row } from "./Pages.tsx"

/** How many days ahead a deadline or a break joins Yours */
const DUE_DAYS = 3

/** How many weeks the term's page looks ahead */
const TERM_WEEKS = 16

const DATE_KIND: Record<KeyDate["kind"], string> = { deadline: "Deadline", registration: "Registration", break: "No classes", term: "Term" }

const STANDING: Record<Standing, string> = { "first-year": "First-years", sophomore: "Sophomores", junior: "Juniors", senior: "Seniors" }

/** A date as a row has it, to its last day where it's a break of days in a row */
type Dated = KeyDate & { until: CalendarDay }

const isForYou = (date: KeyDate, standing: Standing | null) =>
  !date.audience || !standing || date.audience === standing

/** The academic calendar's dates between two days, for your standing, a break of days in a row as one */
const datesFrom = (from: CalendarDay, to: CalendarDay, standing = state.standing.value) =>
  state.coursesIndex.value.calendar.dates
    .filter(date => date.day >= from && date.day < to && isForYou(date, standing))
    .reduce<Dated[]>((dates, date) => {
      const last = date.kind === "break" ? dates.findLast(({ kind }) => kind === "break") : undefined
      if (last && addDays(last.until, 1) === date.day) {
        last.until = date.day
        // Named by the holiday it's for, where a day of it says, over "No Classes"
        if (/Thanksgiving|Recess|Break|Holiday/.test(date.title) && !/Thanksgiving|Recess|Break|Holiday/.test(last.title))
          last.title = date.title
      }
      else
        dates.push({ ...date, until: date.day })
      return dates
    }, [])

export const DateRow = ({ date }: { date: Dated }) =>
  <Row
    class={`date date-${date.kind}`}
    time={<><Day of={date.day} month="short" day="numeric" /><small>{date.until > date.day ? <>– <Day of={date.until} month="short" day="numeric" /></> : <Day of={date.day} weekday="short" />}</small></>}
    what={date.title}
    sub={date.detail ?? DATE_KIND[date.kind]}
  />

/** Deadlines, registration and breaks in the next few days, in Yours as they're near */
export const dueSoon = () => {
  const today = localDay(nowMs())
  return datesFrom(today, addDays(today, DUE_DAYS + 1)).filter(({ kind }) => kind !== "term")
}

/** A game at home: Athletics', at a place on the map */
const isHomeGame = ({ source, place }: Pick<Event, "source" | "place">) =>
  source === "athletics" && place !== undefined

/**
 * The events between two days worth planning for: yours, saved or going, and the public ones, home games and one-offs
 * from UNH's pages
 */
const eventsBetween = (from: CalendarDay, to: CalendarDay) =>
  [...state.events.value.events, ...state.pins.value].flatMap(event => {
    const day = localDay(event.start)
    if (day < from || day >= to)
      return []
    const mine = state.isSessionSaved(event) || isGoing(event)
    const highlight = isHomeGame(event) || event.source === "curated" && !state.activityOf(event)
    return mine || highlight ? [{ event, day, mine, highlight }] : []
  }).sort((a, b) => a.event.start - b.event.start)

export const PlanAhead = () =>
  r(() => {
    const today = localDay(nowMs())
    const from = addDays(today, DUE_DAYS + 1)
    const to = addDays(today, TERM_WEEKS * 7)
    const dates = datesFrom(from, to)
    const events = eventsBetween(from, to)
    const opening = dates.find(date => date.kind === "registration" && date.audience === state.standing.value)
    const saved = events.find(item => item.mine)
    const personal = saved && (!opening || saved.day < opening.day) ? saved : opening
    const campus = dates.find(date => !date.audience && date.kind !== "registration")
    const highlight = events.find(item => item.highlight && item !== personal)
    const picks = [personal, campus, highlight].flatMap(item => item ? [item] : [])
      .sort((a, b) => a.day.localeCompare(b.day))
    if (!picks.length)
      return null
    return <>
      <h2 class="eyebrow">Plan ahead</h2>
      <ul class="rows ahead">{picks.map(item => "event" in item ? <EventRow event={item.event} day="" /> : <DateRow date={item} />)}</ul>
      <button type="button" class="more" onclick={() => state.go({ kind: "ahead" })}>Full term ›</button>
    </>
  })

export const AheadView = () => {
  state.focusAt({ kind: "ahead" }, undefined)
  return r(() => {
    const now = nowMs()
    const today = localDay(now)
    const to = addDays(today, TERM_WEEKS * 7)
    const standing = state.standing.value
    const from = addDays(today, 1)
    const items = [
      ...datesFrom(from, to, standing).map(date => ({ day: date.day, row: <DateRow date={date} /> })),
      ...eventsBetween(from, to)
        .filter(({ event, mine }) => mine || !isHomeGame(event))
        .map(({ day, event }) => ({ day, row: <EventRow event={event} day="" /> }))
    ].sort((a, b) => a.day.localeCompare(b.day))
    const months = groupBy(items, ({ day }) => day.slice(0, 7))
    return <>
      <Head kind="This term" title="Plan ahead" />
      <div class="chips standing" role="group" aria-label="Your class standing">
        <button type="button" class="chip" aria-pressed={standing === null ? "true" : "false"} onclick={() => state.standing.value = null}>All windows</button>
        {STANDINGS.map(one => <button type="button" class="chip" aria-pressed={standing === one ? "true" : "false"} onclick={() => state.standing.value = one}>{STANDING[one]}</button>)}
      </div>
      <p class="view-facts muted">{standing ? `Registration windows for ${STANDING[standing].toLowerCase()}. ` : "Every registration window. "}Shared across your linked devices.</p>
      {[...months].map(([month, rows]) => <>
        <h2 class="eyebrow"><Day of={`${month}-01`} month="long" /></h2>
        <ul class="rows ahead">{rows.map(({ row }) => row)}</ul>
      </>)}
      <p class="view-foot muted">From UNH's academic calendar and UNH's pages.</p>
    </>
  })
}
