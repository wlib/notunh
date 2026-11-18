/** @jsxImportSource bruh/browser */

// The home, under the search, as two views named in its own type: Today, a timeline, and Campus, a directory
// (Campus.tsx), the one last left opening again on this device. Today leads with what you're due at next, once you
// have anything, as the one card on the page: a saved class, a final, the next thing in the calendars you've imported,
// a session you've saved, the next of an activity you follow or an event you're going to, whichever is soonest today.
// Then Yours, the rest of those (state/courses.mts, state/finals.mts, state/calendars.mts, state/saves.mts), the
// sooner first, with deadlines and breaks in the next few days, the reminders set on this phone (Remind.tsx) and the
// trips saved here (state/trip.mts), each a row that opens its page or plans its trip. Then what's on now and the next
// few things today (state/today.mts), what recurs folded under them by kind, with making an event of your own as the
// last row, and the ways on to the week and the term. With nothing of yours it's the day's list alone, which leads.
// While the search is typed in, its suggestions lie over the view (Search.tsx), which stays as it was beneath them,
// scrolled and opened as it was, and the sheet the size it was

import { r } from "bruh/reactive"
import type { BruhChild } from "bruh/browser"
import { codeOf, courseOf } from "../../courses/course.mts"
import type { Dated } from "../../courses/saved.mts"
import { whereOf } from "../../social/event.mts"
import { localDay } from "../../shared/time.mts"
import { ClockTime, Day, minutesText } from "../../shell/intl.tsx"
import { remembered } from "../../shell/state.mts"
import { Icon } from "../../shell/ui.tsx"
import { capture } from "../../shell/usage.tsx"
import type { Imported } from "../state/calendars.mts"
import type { YourFinal } from "../state/finals.mts"
import { state } from "../state/map.mts"
import { nowMs, walkTo } from "./common.tsx"
import { DayName, EventLines, EventRow, FinalWhere, Row, placeNamed, sectionPage } from "./Pages.tsx"
import { DateRow, dueSoon, finalsSoon } from "./Ahead.tsx"
import { CampusIndex } from "./Campus.tsx"
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

/** One of your finals as a row: when, what and where, and when to leave for it */
const FinalRow = ({ yours: { term, section, final, event } }: { yours: YourFinal }) => {
  const walk = walkTo(placeNamed(event.place))
  const leave = walk === undefined ? undefined : event.start - walk * 1000
  return (
    <Row
      class="final"
      time={<When at={event.start} />}
      what={<>{courseOf(section)} final · <FinalWhere final={final} /></>}
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

/** Something of yours with a time: its row in Yours, and what the card says of it while it's next */
type Mine = { start: number, end: number, title: string, where: BruhChild, note?: BruhChild, open: () => void, row: () => BruhChild }

/** Everything of yours with a time, the sooner first: your classes, your finals, the next import, and your events */
const mine = (): Mine[] => {
  const imported = state.nextImport.value
  return [
    ...state.classes.value.map((dated): Mine => {
      const walk = walkTo(placeNamed(dated.event.place))
      const leave = walk === undefined ? undefined : dated.event.start - walk * 1000
      return {
        start: dated.event.start,
        end:   dated.event.end,
        title: courseOf(dated.section),
        where: dated.event.where,
        note:  leave !== undefined && leave > nowMs() ? <>leave <ClockTime at={new Date(leave)} /></> : undefined,
        open:  () => state.go(sectionPage(dated.term, dated.section)),
        row:   () => <ClassRow dated={dated} />
      }
    }),
    ...finalsSoon().map((yours): Mine => {
      const walk = walkTo(placeNamed(yours.event.place))
      const leave = walk === undefined ? undefined : yours.event.start - walk * 1000
      return {
        start: yours.event.start,
        end:   yours.event.end,
        title: `${courseOf(yours.section)} final`,
        where: <FinalWhere final={yours.final} />,
        note:  leave !== undefined && leave > nowMs() ? <>leave <ClockTime at={new Date(leave)} /></> : undefined,
        open:  () => state.go(sectionPage(yours.term, yours.section)),
        row:   () => <FinalRow yours={yours} />
      }
    }),
    ...imported ? [{
      start: imported.start,
      end:   imported.start,
      title: imported.event.title,
      where: imported.event.where || imported.match.place || "Your calendar",
      open:  () => state.go(imported.match.found ? sectionPage(imported.match.found.term, imported.match.found.section) : imported.match.place ? { kind: "place", name: imported.match.place } : { kind: "you" }),
      row:   () => <ImportRow imported={imported} />
    } satisfies Mine] : [],
    ...state.yoursNext.value.map((event): Mine => ({
      start: event.start,
      end:   event.end,
      title: event.title,
      where: whereOf(event),
      open:  () => state.go({ kind: "event", id: event.id }),
      row:   () => <EventRow event={event} />
    }))
  ].sort((a, b) => a.start - b.start)
}

/** What you're due at next today, which the card leads with: under way, or the soonest still to start */
const nextOf = (all: Mine[]) => {
  const now = nowMs()
  return all.find(({ start, end }) => localDay(start) === localDay(now) && Math.max(end, start) > now)
}

// ms before something starts that the card counts down to it, rather than saying its time alone
const SOON_MS = 60 * 60_000

/** The one card on the home: what you're due at next, when, where, and when to leave, which opens it */
const Next = ({ next }: { next: Mine }) => {
  const till = next.start - nowMs()
  return (
    <button type="button" class="poster next" onclick={next.open}>
      <span class="poster-label">{till <= 0 ? "Now" : till < SOON_MS ? `In ${minutesText(Math.max(1, Math.round(till / 60_000)))}` : "Next"}</span>
      <strong>{next.title}</strong>
      <span class="next-facts"><ClockTime at={new Date(next.start)} /> · {next.where}{next.note && <> · {next.note}</>}</span>
    </button>
  )
}

/**
 * Yours: what you're due at next as the card, the list's first, then the rest of your classes, the next thing in your calendars, the
 * sessions you've saved, the next of each activity you follow and the events you're going to, the sooner first, then
 * deadlines and breaks in the next few days, the reminders and the saved trips, as one list, when there's any
 */
const Yours = () => {
  const due = r(dueSoon)
  const all = r(mine)
  const next = r(() => nextOf(all.value))
  const list: HTMLUListElement =
    <ul class="rows" aria-label="Yours">
      {r(() => next.value && <li class="lead"><Next next={next.value} /></li>)}
      {r(() => all.value.filter(item => item !== next.value).map(({ row }) => row()))}
      {r(() => due.value.map(date => <DateRow date={date} />))}
      <Reminders />
      <Goals />
    </ul>
  return (
    <section class="yours">
      {/* The card says what it leads, so the list is named only without one */}
      {r(() => !next.value && (all.value.length > 0 || state.goals.value.length > 0 || currentReminders.value.length > 0 || due.value.length > 0) && <h2 class="eyebrow">Yours</h2>)}
      {list}
    </section>
  )
}

/** Whether there's anything of yours to show, which the day's list is then labelled apart from */
const hasYours = () =>
  state.classes.value.length > 0 || finalsSoon().length > 0 || state.nextImport.value !== undefined || state.yoursNext.value.length > 0 || state.goals.value.length > 0 || currentReminders.value.length > 0 || dueSoon().length > 0

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
 * event as the last row, and the week's page and the term's for the rest
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
      {/* Under the view's own name, the day's list needs none unless something comes between them */}
      {(on.length > 0 || hasYours()) && <h2 class="eyebrow">{on.length ? "Later today" : "On today"}</h2>}
      <ul class="rows" aria-label="Today">
        <EventLines events={later} rows={NEXT_FEW} />
        <NewEvent />
      </ul>
      <nav class="onward" aria-label="Further ahead">
        <button type="button" class="more" onclick={() => state.go({ kind: "week" })}>This week ›</button>
        <button type="button" class="more" onclick={() => state.go({ kind: "ahead" })}>Plan ahead ›</button>
      </nav>
    </>
  })

type View = "today" | "campus"

/** The view the home shows, as last left on this device */
const view = remembered<View>("home-view", stored => stored === "campus" ? "campus" : "today")

/** The home's two views, named in its largest type, the one shown pressed, with the day beside them */
const Views = () => {
  const Tab = ({ of, children }: { of: View, children?: BruhChild }) =>
    <button type="button" aria-pressed={r(() => String(view.value === of))} onclick={() => view.value = of}>{children}</button>
  return (
    <nav class="views" aria-label="View">
      <Tab of="today">Today</Tab>
      <Tab of="campus">Campus</Tab>
      <span class="views-day eyebrow">{r(() => <Day of={localDay(nowMs())} weekday="short" month="short" day="numeric" />)}</span>
    </nav>
  )
}

export const Home = () =>
  <section class="home">
    <SearchRow />
    <div class="home-body">
      <div class="agenda" inert={isSearching} aria-hidden={r(() => isSearching.value ? "true" : undefined)}>
        <Views />
        {/* Both stay made, so each is as it was left, scrolled and opened, when the other's put away */}
        <div class="agenda-view" hidden={r(() => view.value !== "today")}>
          <Yours />
          <Today />
        </div>
        <div class="agenda-view" hidden={r(() => view.value !== "campus")}>
          <CampusIndex />
          <a class="more about" href="/">About notunh ›</a>
        </div>
      </div>
      {r(() => isSearching.value && <Suggestions />)}
    </div>
  </section>

export { NewEvent }
