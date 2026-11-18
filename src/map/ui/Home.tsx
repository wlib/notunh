/** @jsxImportSource bruh/browser */

// The home, under the search: what's yours and what's on today, short enough to read with the sheet half up. First the
// ways into the lists of their own: clubs and activities, the week, and the term ahead (Explore.tsx, Ahead.tsx). Then
// Yours, when you have anything: your saved classes for the rest of today, or else your next (state/courses.mts), the
// next thing in the calendars you've imported (state/calendars.mts), the sessions you've saved, the next of each
// activity you follow and the events you're going to (state/saves.mts), the sooner first; then deadlines and breaks
// in the next few days, the reminders set on this phone (Remind.tsx) and the trips saved here (state/trip.mts), each
// a row that opens its page or plans its trip. Then what's on now and the next few things today (state/today.mts),
// what recurs folded under them by kind, with making an event of your own as the last row, and the week's page for
// the rest; then plan ahead, three rows. While the search is typed in, its suggestions lie over the list (Search.tsx),
// which stays as it was beneath them, scrolled and opened as it was, and the sheet the size it was

import { r } from "bruh/reactive"
import { codeOf, courseOf } from "../../courses/course.mts"
import type { Dated } from "../../courses/saved.mts"
import { localDay } from "../../shared/time.mts"
import { ClockTime } from "../../shell/intl.tsx"
import { Icon } from "../../shell/ui.tsx"
import { capture } from "../../shell/usage.tsx"
import type { Imported } from "../state/calendars.mts"
import { state } from "../state/map.mts"
import { nowMs, walkTo } from "./common.tsx"
import { DayName, EventLines, EventRow, Row, placeNamed, sectionPage } from "./Pages.tsx"
import { Shortcuts } from "./Explore.tsx"
import { DateRow, PlanAhead, dueSoon } from "./Ahead.tsx"
import { Reminders, currentReminders } from "./Remind.tsx"
import { Suggestions, SearchRow, isSearching } from "./Search.tsx"

/** When a row of Yours is: the time today, else the day with the time under it */
const When = ({ at }: { at: number }) =>
  localDay(at) === localDay(nowMs())
    ? <ClockTime at={new Date(at)} />
    : <><DayName day={localDay(at)} /><small><ClockTime at={new Date(at)} /></small></>

/** A saved class as a row: when, what and where, and when to leave for it */
const ClassRow = ({ dated: { event, term, section } }: { dated: Dated }) => {
  const walk = walkTo(placeNamed(event.place))
  const leave = walk === undefined ? undefined : event.start - walk * 1000
  return (
    <Row
      time={<When at={event.start} />}
      what={`${courseOf(section)} · ${event.where}`}
      sub={leave !== undefined && leave > nowMs() ? <>leave <ClockTime at={new Date(leave)} /></> : codeOf(section)}
      onclick={() => state.go(sectionPage(term, section))}
    />
  )
}

/** A thing in the calendars imported here as a row, which opens its section's page, its place's, or else You */
const ImportRow = ({ imported: { event, start, match: { found, place } } }: { imported: Imported }) =>
  <Row
    time={<When at={start} />}
    what={event.title}
    sub={event.where || place || "Your calendar"}
    onclick={() => state.go(found ? sectionPage(found.term, found.section) : place ? { kind: "place", name: place } : { kind: "you" })}
  />

/** The trips saved here, each a row that plans getting there by its time from where you are, or forgets it */
const Goals = () =>
  r(() => state.goals.value.map(goal =>
    <Row
      time={<>by <ClockTime at={new Date(`${localDay(nowMs())}T${goal.by}:00`)} /></>}
      what={goal.name}
      sub="Saved trip"
      onclick={() => {
        state.openGoal(goal)
        state.go({ kind: "directions" })
        capture("goal_opened")
      }}
      aside={
        <button type="button" class="clear" aria-label={`Forget ${goal.name}`} onclick={() => state.forgetGoal(goal)}>
          <Icon name="close" />
        </button>
      }
    />
  ))

/**
 * Yours: your classes, the next thing in your calendars, the sessions you've saved, the next of each activity you
 * follow and the events you're going to, the sooner first, then deadlines and breaks in the next few days, the
 * reminders and the saved trips, as one list, when there's any
 */
const Yours = () => {
  const due = r(dueSoon)
  const mine = state.yoursNext
  const list: HTMLUListElement =
    <ul class="rows" aria-label="Yours">
      {r(() => {
        const imported = state.nextImport.value
        return [
          ...state.classes.value.map(dated => ({ start: dated.event.start, row: <ClassRow dated={dated} /> })),
          ...imported ? [{ start: imported.start, row: <ImportRow imported={imported} /> }] : [],
          ...mine.value.map(event => ({ start: event.start, row: <EventRow event={event} /> }))
        ].sort((a, b) => a.start - b.start).map(({ row }) => row)
      })}
      {r(() => due.value.map(date => <DateRow date={date} />))}
      <Reminders />
      <Goals />
    </ul>
  return (
    <section class="yours">
      {r(() => (state.classes.value.length > 0 || state.nextImport.value || state.goals.value.length > 0 || currentReminders.value.length > 0 || due.value.length > 0 || mine.value.length > 0) && <h2 class="eyebrow">Yours</h2>)}
      {list}
    </section>
  )
}

/** The row that makes an event of your own, last in today's list, where the gap is */
const NewEvent = ({ place }: { place?: string }) =>
  <li>
    <button type="button" class="row add" onclick={() => state.go({ kind: "new", ...place && { place } })}>
      <span class="row-what"><strong>+ New event{place && " here"}</strong></span>
    </button>
  </li>

/** How many of today's one-offs the home shows before the week's page */
const NEXT_FEW = 4

/**
 * Today: what's on now, then the next few things later today, each kind of what recurs folded under them, with New
 * event as the last row, and the week's page for the rest
 */
const Today = () =>
  r(() => {
    const now = nowMs()
    const on = state.todayList.value.filter(event => event.start <= now && now < event.end)
    const later = state.todayList.value.filter(event => event.start > now)
    return <>
      {on.length > 0 && <>
        <h2 class="eyebrow">Now</h2>
        <ul class="rows" aria-label="Now"><EventLines events={on} standing={<span class="on">On</span>} rows={NEXT_FEW} /></ul>
      </>}
      <h2 class="eyebrow">{on.length ? "Later today" : "Today"}</h2>
      <ul class="rows" aria-label="Today">
        <EventLines events={later} rows={NEXT_FEW} />
        <NewEvent />
      </ul>
      <button type="button" class="more" onclick={() => state.go({ kind: "week" })}>Browse this week ›</button>
    </>
  })

export const Home = () =>
  <section class="home">
    <SearchRow />
    <div class="home-body">
      <div class="agenda" inert={isSearching} aria-hidden={r(() => isSearching.value ? "true" : undefined)}>
        <Shortcuts />
        <Yours />
        <Today />
        <PlanAhead />
      </div>
      {r(() => isSearching.value && <Suggestions />)}
    </div>
  </section>

export { NewEvent }
