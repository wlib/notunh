/** @jsxImportSource bruh/browser */

// The home, under the search: what's yours and what's on today, short enough to read with the sheet half up. First the
// ways into the lists of their own: clubs and activities, the week, and the term ahead (Explore.tsx, Ahead.tsx). Then
// Yours, when you have anything: your next saved class (state/courses.mts), the next thing in the calendars you've
// imported (state/calendars.mts), deadlines and breaks in the next few days, the sessions you've saved, the next of
// each activity you follow and the events you're going to (state/saves.mts), the reminders set on this phone
// (Remind.tsx) and the trips saved here (state/trip.mts), each a row that opens its page or plans its trip. Then
// what's on now and the next few things today (state/today.mts), what recurs folded under them by kind, with making an
// event of your own as the last row, and the week's page for the rest; then plan ahead, three rows. While the search
// is typed in, its suggestions lie over the list (Search.tsx), which stays as it was beneath them, scrolled and opened
// as it was, and the sheet the size it was

import { r } from "bruh/reactive"
import { codeOf, courseOf } from "../../courses/course.mts"
import { isClassAt } from "../../courses/imported.mts"
import { localDay } from "../../shared/time.mts"
import { ClockTime } from "../../shell/intl.tsx"
import { Icon } from "../../shell/ui.tsx"
import { capture } from "../../shell/usage.tsx"
import { state } from "../state/map.mts"
import { nowMs, walkTo } from "./common.tsx"
import { DayName, EventLines, EventRow, Row, placeNamed, sectionPage } from "./Pages.tsx"
import { Shortcuts } from "./Explore.tsx"
import { DateRow, PlanAhead, dueSoon } from "./Ahead.tsx"
import { Reminders, currentReminders } from "./Remind.tsx"
import { Suggestions, SearchRow, isSearching } from "./Search.tsx"

/** Your next saved class, as a row: when, what and where, and when to leave for it */
const NextClass = () =>
  r(() => {
    const next = state.nextClass.value
    if (!next)
      return null
    const { event, term, section } = next
    const walk = walkTo(placeNamed(event.place))
    const leave = walk === undefined ? undefined : event.start - walk * 1000
    const isToday = localDay(event.start) === localDay(nowMs())
    return (
      <Row
        time={isToday ? <ClockTime at={new Date(event.start)} /> : <><DayName day={localDay(event.start)} /><small><ClockTime at={new Date(event.start)} /></small></>}
        what={`${courseOf(section)} · ${event.where}`}
        sub={leave !== undefined && leave > nowMs() ? <>leave <ClockTime at={new Date(leave)} /></> : codeOf(section)}
        onclick={() => state.go(sectionPage(term, section))}
      />
    )
  })

/** The next thing in the calendars imported here, as a row, unless it's your next class, which is told as that */
const NextImport = () =>
  r(() => {
    const next = state.nextImport.value
    const lesson = state.nextClass.value
    if (!next || lesson && isClassAt(next, lesson.section, lesson.event.start))
      return null
    const { event, start, match: { found, place } } = next
    return (
      <Row
        time={localDay(start) === localDay(nowMs()) ? <ClockTime at={new Date(start)} /> : <><DayName day={localDay(start)} /><small><ClockTime at={new Date(start)} /></small></>}
        what={event.title}
        sub={event.where || place || "Your calendar"}
        onclick={() => state.go(found ? sectionPage(found.term, found.section) : place ? { kind: "place", name: place } : { kind: "you" })}
      />
    )
  })

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
 * Yours: the next class and the next thing in your calendars, the sooner first, deadlines and breaks in the next few
 * days, the sessions you've saved, the next of each activity you follow and the events you're going to, the reminders
 * and the saved trips, as one list, when there's any
 */
const Yours = () => {
  const due = r(dueSoon)
  const mine = state.yoursNext
  const list: HTMLUListElement =
    <ul class="rows" aria-label="Yours">
      {r(() => state.nextImport.value && state.nextClass.value && state.nextImport.value.start < state.nextClass.value.event.start
        ? <><NextImport /><NextClass /></>
        : <><NextClass /><NextImport /></>)}
      {r(() => due.value.map(date => <DateRow date={date} />))}
      {r(() => mine.value.map(event => <EventRow event={event} />))}
      <Reminders />
      <Goals />
    </ul>
  return (
    <section class="yours">
      {r(() => (state.nextClass.value || state.nextImport.value || state.goals.value.length > 0 || currentReminders.value.length > 0 || due.value.length > 0 || mine.value.length > 0) && <h2 class="eyebrow">Yours</h2>)}
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
