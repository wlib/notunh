/** @jsxImportSource bruh/browser */

// The home, under the search, as one page in two parts, each named in its own type at the top, where a tap scrolls to
// it and the one in view is lit: Today, a timeline, and Campus, a directory (Campus.tsx). Today is one day read down:
// what you're due at next, once you have anything, as the one card, a saved class, a final, the next thing in the
// calendars you've imported, a session you've saved, the next of an activity you follow or an event you're going to,
// whichever is soonest or under way; then what's on now and the next few things today (state/today.mts) with the rest
// of what's yours today in its place among them by its time, washed in gold, the card's own event too, what recurs
// folded under them by kind, and making an event of your own as the last row. Then Yours beyond today, the sooner first
// (state/courses.mts, state/finals.mts, state/calendars.mts, state/saves.mts), with deadlines and breaks in the next
// few days, the reminders set on this phone (Remind.tsx) and the trips saved here (state/trip.mts); then plan ahead,
// three rows, and the week. With nothing of yours it's the day's list alone, which leads. While the search is typed in,
// its suggestions lie over the page (Search.tsx), which stays as it was beneath them, scrolled and opened as it was,
// and the sheet the size it was

import { r } from "bruh/reactive"
import type { BruhChild } from "bruh/browser"
import { codeOf, courseOf } from "../../courses/course.mts"
import type { Dated } from "../../courses/saved.mts"
import { whereOf } from "../../social/event.mts"
import { localDay } from "../../shared/time.mts"
import { ClockTime, Day, minutesText } from "../../shell/intl.tsx"
import { Icon } from "../../shell/ui.tsx"
import { capture } from "../../shell/usage.tsx"
import type { Imported } from "../state/calendars.mts"
import type { YourFinal } from "../state/finals.mts"
import { state } from "../state/map.mts"
import { nowMs, walkTo } from "./common.tsx"
import { DayName, EventLines, EventRow, FinalWhere, Row, placeNamed, sectionPage } from "./Pages.tsx"
import { DateRow, PlanAhead, dueSoon, finalsSoon } from "./Ahead.tsx"
import { CampusIndex } from "./Campus.tsx"
import { Reminders, currentReminders } from "./Remind.tsx"
import { Suggestions, SearchRow, isSearching } from "./Search.tsx"

/** When a row of Yours is: the time today, else the day with the time under it */
const When = ({ at }: { at: number }) =>
  localDay(at) === localDay(nowMs())
    ? <ClockTime at={new Date(at)} />
    : <><DayName day={localDay(at)} /><small><ClockTime at={new Date(at)} /></small></>

/** A saved class as a row, washed as what's yours is: when, what and where, and when to leave for it */
const ClassRow = ({ dated: { event, term, section } }: { dated: Dated }) => {
  const walk = walkTo(placeNamed(event.place))
  const leave = walk === undefined ? undefined : event.start - walk * 1000
  return (
    <Row
      class="yours"
      time={<When at={event.start} />}
      what={`${courseOf(section)} · ${event.where}`}
      sub={leave !== undefined && leave > nowMs() ? <>leave <ClockTime at={new Date(leave)} /></> : codeOf(section)}
      onclick={() => state.go(sectionPage(term, section))}
    />
  )
}

/** One of your finals as a row, washed as what's yours is: when, what and where, and when to leave for it */
const FinalRow = ({ yours: { term, section, final, event } }: { yours: YourFinal }) => {
  const walk = walkTo(placeNamed(event.place))
  const leave = walk === undefined ? undefined : event.start - walk * 1000
  return (
    <Row
      class="yours final"
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
    class="yours"
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
 * Something of yours with a time: its row, what the card says of it while it's next, and whether it's an event, which
 * the day's list has already
 */
type Mine = { start: number, end: number, title: string, where: BruhChild, note?: BruhChild, event?: true, open: () => void, row: () => BruhChild }

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
      event: true,
      open:  () => state.go({ kind: "event", id: event.id }),
      row:   () => <EventRow event={event} />
    }))
  ].sort((a, b) => a.start - b.start)
}

const isToday = ({ start }: Pick<Mine, "start">) =>
  localDay(start) === localDay(nowMs())

/** What you're due at today, which the card leads with: what's under way, else the soonest still to start */
const nextOf = (all: Mine[]) => {
  const now = nowMs()
  return all.find(item => isToday(item) && Math.max(item.end, item.start) > now)
}

// ms before something starts that the card counts down to it, rather than saying its time alone
const SOON_MS = 60 * 60_000

/**
 * The one card on the home: what you're due at next, when, where, and when to leave, or what you're at now and till
 * when, which opens it
 */
const Next = ({ next }: { next: Mine }) => {
  const till = next.start - nowMs()
  return (
    <button type="button" class="poster next" onclick={next.open}>
      <span class="poster-label">{till <= 0 ? "Now" : till < SOON_MS ? `In ${minutesText(Math.max(1, Math.round(till / 60_000)))}` : "Next"}</span>
      <strong>{next.title}</strong>
      <span class="next-facts">
        {till <= 0 && next.end > next.start ? <>till <ClockTime at={new Date(next.end)} /></> : <ClockTime at={new Date(next.start)} />} · {next.where}{next.note && <> · {next.note}</>}
      </span>
    </button>
  )
}

/** Everything of yours with a time, and which of it the card leads with, made once the home is, as the state is by then */
const yoursNow = () =>
  r(() => {
    const all = mine()
    return { all, next: nextOf(all) }
  })

type YoursNow = ReturnType<typeof yoursNow>

/**
 * Yours beyond today: your next class where there's none left today, the next thing in your calendars, the sessions
 * you've saved, the next of each activity you follow and the events you're going to, the sooner first, then deadlines
 * and breaks in the next few days, the reminders and the saved trips, as one list, when there's any. What's yours
 * today is in the day's own list, in its place
 */
const Yours = ({ yours }: { yours: YoursNow }) => {
  const due = r(dueSoon)
  const later = r(() => yours.value.all.filter(item => !isToday(item)))
  const list: HTMLUListElement =
    <ul class="rows" aria-label="Yours">
      {r(() => later.value.map(({ row }) => row()))}
      {r(() => due.value.map(date => <DateRow date={date} />))}
      <Reminders />
      <Goals />
    </ul>
  return (
    <section class="yours">
      {r(() => (later.value.length > 0 || state.goals.value.length > 0 || currentReminders.value.length > 0 || due.value.length > 0) && <h2 class="eyebrow">Yours</h2>)}
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
 * Today, one day read down: the card, then what's on now, then the next few things later today with the rest of
 * what's yours today among them by its time, each kind of what recurs folded under them, and New event as the last row
 */
const Today = ({ yours }: { yours: YoursNow }) =>
  r(() => {
    const now = nowMs()
    const { all, next } = yours.value
    // The card says what's next and the day's events stay whole under it, so one starred stays where it was starred.
    // What else is yours today, which has no star, takes its place by its time, but for the card's own, said already
    const on = state.todayList.value.filter(event => event.start <= now && now < event.end)
    const later = state.todayList.value.filter(event => event.start > now)
    const also = all.filter(item => item !== next && !item.event && isToday(item) && item.start > now).map(({ start, row }) => ({ start, row: row() }))
    return <>
      {next && <Next next={next} />}
      {on.length > 0 && <>
        <h2 class="eyebrow">Now</h2>
        <ul class="rows" aria-label="Now"><EventLines events={on} standing={<span class="on">On</span>} rows={NEXT_FEW} /></ul>
      </>}
      {/* Under the part's own name, the day's list needs none unless something comes between them */}
      {(on.length > 0 || next) && <h2 class="eyebrow">{on.length ? "Later today" : "Today"}</h2>}
      <ul class="rows" aria-label="Today">
        <EventLines events={later} rows={NEXT_FEW} also={also} />
        <NewEvent />
      </ul>
    </>
  })

const PARTS = ["today", "campus"] as const
type Part = typeof PARTS[number]

/** The part of the home in view, which its name at the top is lit for */
const inView = r<Part>("today")

// px a part's top may be under the names before it counts as the one in view
const NEAR = 24

/**
 * The home's two parts by name, in its largest type, staying at the top as the page scrolls under them, the one in
 * view lit, with the day beside them. Each is a link to its part, which a tap scrolls to within the sheet, leaving
 * the address and the history as they are
 */
const Parts = () => {
  const nav: HTMLElement =
    <nav class="parts" aria-label="Parts of the page">
      {PARTS.map(part =>
        <a
          href={`#${part}`}
          aria-current={r(() => inView.value === part ? "true" : undefined)}
          onclick={(event: MouseEvent) => {
            event.preventDefault()
            const body = nav.closest(".panel-body")
            const to = document.getElementById(part)
            if (!body || !to)
              return
            // To just under the names where they stick, at the body's top, wherever they are now
            const top = part === PARTS[0] ? 0 : body.scrollTop + to.getBoundingClientRect().top - body.getBoundingClientRect().top - nav.offsetHeight
            body.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
          }}
        >
          {part[0].toUpperCase() + part.slice(1)}
        </a>
      )}
      <span class="parts-day eyebrow">{r(() => <Day of={localDay(nowMs())} weekday="short" month="short" day="numeric" />)}</span>
    </nav>
  // The last part whose top has reached the names is the one in view, and at the page's foot the last is, as it may
  // be too short to reach them. Heard as the sheet's body scrolls, which doesn't bubble, so on its way down
  document.addEventListener("scroll", ({ target }) => {
    if (!(target instanceof Element) || !target.contains(nav))
      return
    const under = target.getBoundingClientRect().top + nav.offsetHeight + NEAR
    const isFoot = target.scrollTop + target.clientHeight >= target.scrollHeight - 2 && target.scrollTop > 0
    inView.value = isFoot ? PARTS[PARTS.length - 1] : PARTS.findLast(part => (document.getElementById(part)?.getBoundingClientRect().top ?? Infinity) <= under) ?? PARTS[0]
  }, { capture: true, passive: true })
  return nav
}

export const Home = () => {
  const yours = yoursNow()
  return <section class="home">
    <SearchRow />
    <div class="home-body">
      <div class="agenda" inert={isSearching} aria-hidden={r(() => isSearching.value ? "true" : undefined)}>
        <Parts />
        <section id="today" class="agenda-part" aria-label="Today">
          <Today yours={yours} />
          <Yours yours={yours} />
          <PlanAhead />
        </section>
        <section id="campus" class="agenda-part" aria-label="Campus">
          <CampusIndex />
          <a class="more about" href="/">About notunh ›</a>
        </section>
      </div>
      {r(() => isSearching.value && <Suggestions />)}
    </div>
  </section>
}

export { NewEvent }
