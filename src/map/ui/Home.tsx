/** @jsxImportSource bruh/browser */

// The home, under the search: the week as one list. Yours first, when you have anything: your next saved class
// (state/courses.mts), the reminders set on this phone (Remind.tsx) and the trips saved here (state/trip.mts), each a
// row that opens its page or plans its trip. Then what's on now, later today (state/today.mts), with making an event
// of your own as the last row of today, and each day to come under its own heading (src/social/event.mts), a week at
// a time. While the search is typed in, its suggestions lie over the list (Search.tsx), which stays as it was beneath
// them, scrolled and opened as it was, and the sheet the size it was

import { r } from "bruh/reactive"
import { type DayList, type Event, type Pin, WEEK, upcoming } from "../../social/event.mts"
import { codeOf, courseOf } from "../../courses/course.mts"
import { daysBetween, localDay, nextAt } from "../../shared/time.mts"
import { ClockTime, Day, relativeDay } from "../../shell/intl.tsx"
import { Icon } from "../../shell/ui.tsx"
import { capture } from "../../shell/usage.tsx"
import { state } from "../state/map.mts"
import { nowMs, walkTo } from "./common.tsx"
import { DayName, EventRow, Row, placeNamed, sectionPage } from "./Pages.tsx"
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

/** Yours: the next class, the reminders and the saved trips, as one list, when there's any */
const Yours = () => {
  const list: HTMLUListElement =
    <ul class="rows" aria-label="Yours">
      <NextClass />
      <Reminders />
      <Goals />
    </ul>
  return (
    <section class="yours">
      {r(() => (state.nextClass.value || state.goals.value.length > 0 || currentReminders.value.length > 0) && <h2 class="eyebrow">Yours</h2>)}
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

/** Today: what's on now, and later today, with New event as the last row */
const Today = () =>
  r(() => {
    const now = nowMs()
    const on = state.todayList.value.filter(event => event.start <= now && now < event.end)
    const later = state.todayList.value.filter(event => event.start > now)
    return <>
      {on.length > 0 && <>
        <h2 class="eyebrow">Now</h2>
        <ul class="rows" aria-label="Now">{on.map(event => <EventRow event={event} standing={<span class="on">On</span>} />)}</ul>
      </>}
      <h2 class="eyebrow">{on.length ? "Later today" : "Today"}</h2>
      <ul class="rows" aria-label="Today">
        {later.map(event => <EventRow event={event} />)}
        <NewEvent />
      </ul>
    </>
  })

/** A day to come: its heading, "Tomorrow" or "Thursday, Oct 29", and its rows */
const DayRows = ({ day, events }: DayList<Event | Pin>) => {
  const away = daysBetween(localDay(nowMs()), day)
  return <>
    <h2 class="eyebrow">{away === 1 ? relativeDay(1) : <Day of={day} weekday="long" month="short" day="numeric" />}</h2>
    <ul class="rows" aria-label={day}>{events.map(event => <EventRow event={event} day={day} />)}</ul>
  </>
}

/** The days to come, a week at a time, each with what's on it */
const Later = () => {
  const days = r(WEEK)
  return r(() => {
    const listed = upcoming(state.events.value.events, nowMs(), days.value)
    const all = upcoming(state.events.value.events, nowMs(), days.value + WEEK * 3)
    return <>
      {listed.map(day => <DayRows {...day} />)}
      {all.length > listed.length && <button type="button" class="more" onclick={() => days.value += WEEK}>Later ›</button>}
    </>
  })
}

export const Home = () =>
  <section class="home">
    <SearchRow />
    <div class="home-body">
      <div class="agenda" inert={isSearching} aria-hidden={r(() => isSearching.value ? "true" : undefined)}>
        <Yours />
        <Today />
        <Later />
      </div>
      {r(() => isSearching.value && <Suggestions />)}
    </div>
  </section>

export { NewEvent }
