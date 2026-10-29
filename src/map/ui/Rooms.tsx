/** @jsxImportSource bruh/browser */

// A room's page, the rooms at a place, and the rooms search finds to book (state/rooms.mts). A room 25Live books
// leads with whether it's free and till when, then a day's bookings and classes together, any day of the week, and
// Reserve in 25Live; one of Campus Rec's, a court, studio or field, likewise, with its schedule there instead. It
// opens at once from whatever's known and asks the Worker about the room afresh as it opens, as a day is picked, and
// as Reserve is tapped, swapping the answer in place. A booking says only what kind it is and by whom ("Study group",
// "Meeting · Theta Chi") unless this device's UNH email is verified, as a title may name someone. A room 25Live
// doesn't book is the registrar's alone: its classes, which never make it free

import { type DerivativeNode, r } from "bruh/reactive"
import type { Page } from "../link.mts"
import { state } from "../state/map.mts"
import { ASK_AHEAD, type Booking, type Space, type Standing, bookingsOf, fetchedOf, kindOf, reserveUrl } from "../../courses/bookings.mts"
import { type FoundSpace, asksRooms, parseAsked, spaceFor } from "../../courses/spaces.mts"
import { CAMPUS_REC, SCHEDULE } from "../../courses/rec.mts"
import { courseOf } from "../../courses/course.mts"
import type { Courses } from "../../courses/browser/terms.mts"
import { type Scheduled, roomKey } from "../../courses/rooms.mts"
import { type Day, addDays, clockOf, localDay } from "../../shared/time.mts"
import { ClockTime, Counted, List } from "../../shell/intl.tsx"
import { capture } from "../../shell/usage.tsx"
import { nowMs } from "./common.tsx"
import { Group } from "./Courses.tsx"
import { CLASSES_ONLY, DayName, Facts, Go, Head, LinkLine, Row, Source, Span, directions, focusOn, placeNamed, sectionPage, share, withCourses } from "./Pages.tsx"
import { verified } from "./You.tsx"

/** How a room stands, as a row's time column says it: "Free" over "till 3:00 PM" */
const StandingTime = ({ standing }: { standing: Standing }) =>
  <>{standing.isFree ? "Free" : "Busy"}{standing.until !== undefined && <small>till <ClockTime at={new Date(standing.until)} /></small>}</>

/** How a room stands now, as its page leads with it: "Free till 3:00 PM", "Free the rest of today", "Busy till 2:00 PM" */
const StandingLine = ({ standing }: { standing: Standing }) =>
  standing.until === undefined ? <>Free the rest of today</> : <>{standing.isFree ? "Free" : "Busy"} till <ClockTime at={new Date(standing.until)} /></>

/** What a space is, in brief: what 25Live calls it, and how many it holds */
const aboutOf = (space: Space) =>
  [space.name, space.capacity && `${space.capacity} people`].filter(Boolean).join(" · ") || undefined

/** The page's word for where a space's bookings come from */
const sourceOf = (space: Space) =>
  space.source === "rec" ? "Campus Rec" : "25Live"

/** A booking's row, which leads nowhere: when, its title where it's said, else what kind it is, and by whom, unless that may be a person or is Campus Rec, whose page it's on */
const BookingRow = ({ booking }: { booking: Booking }) => {
  const at = nowMs()
  const kind = kindOf(booking)
  const sub = [booking.title && booking.title !== booking.type && kind, booking.org !== CAMPUS_REC && booking.org].filter(Boolean).join(" · ")
  return (
    <li>
      <div class="row">
        <span class="row-time"><Span {...booking} /></span>
        <span class="row-what">
          <strong class="truncate">{booking.title ?? kind ?? "Booked"}</strong>
          {sub && <span class="muted truncate">{sub}</span>}
        </span>
        <span class="row-state">{booking.end <= at ? "ended" : booking.start <= at ? "now" : ""}</span>
      </div>
    </li>
  )
}

/** A class's row, as the registrar schedules it there */
const ClassRow = ({ scheduled: { term, section, event, also } }: { scheduled: Scheduled }) => {
  const at = nowMs()
  return (
    <Row
      time={<Span {...event} />}
      what={<List type="unit" items={[section, ...also].map(courseOf)} />}
      sub={section.title}
      standing={event.end <= at ? "ended" : event.start <= at ? "now" : undefined}
      onclick={() => state.go(sectionPage(term, section))}
    />
  )
}

/** A space, 25Live's or Campus Rec's: how it stands, the day's bookings and classes, the week's days, and Reserve */
const SpaceView = ({ space, where }: { space: Space, where: string }) => {
  const page: Page = { kind: "room", where }
  const isRec = space.source === "rec"
  const today = localDay(nowMs())
  const day = r<Day>(today)
  /** The room asked about afresh for the day shown, as it opens, a day is picked, or Reserve is tapped */
  const refresh = () => {
    state.wantRooms(day.peek())
    state.refreshRoom(space, day.peek())
  }
  refresh()
  focusOn(page, space.place)
  return (
    <>
      <Head kind={<>{isRec ? "Campus Rec" : space.isStudy ? "Study room" : "Room"}{space.capacity && <> · <Counted value={space.capacity} one="person" other="people" /></>}</>} title={space.where} />
      <p class="view-when">{r(() => <StandingLine standing={state.roomStanding(space, state.now.value * 1000)} />)}</p>
      <Facts where={space.place} place={space.place} extra={space.name} />
      <div class="view-actions">
        {!isRec && <a class="button primary" href={reserveUrl(space)} target="_blank" rel="noopener" onclick={() => { refresh(); capture("room_reserve") }}>Reserve in 25Live</a>}
        <button type="button" class={isRec ? "button primary" : "button"} onclick={() => directions(placeNamed(space.place), space.where)}>Directions</button>
        <button type="button" class="button" onclick={() => share(space.where)}>Share</button>
      </div>
      <div class="chips days" role="group" aria-label="Day">
        {[today, addDays(today, 1)].map(shown =>
          <button type="button" class="chip" aria-pressed={r(() => day.value === shown ? "true" : "false")} onclick={() => { day.value = shown; refresh() }}>
            <DayName day={shown} />
          </button>
        )}
        <label class="chip pick" aria-pressed={r(() => day.value > addDays(today, 1) ? "true" : "false")}>
          {r(() => day.value > addDays(today, 1) ? <DayName day={day.value} /> : "Other day")}
          <input
            type="date"
            min={today}
            max={addDays(today, ASK_AHEAD)}
            value={r(() => day.value)}
            onclick={(event: MouseEvent) => (event.currentTarget as HTMLInputElement).showPicker?.()}
            onchange={(event: Event) => {
              const picked = (event.currentTarget as HTMLInputElement).value
              day.value = picked && picked >= today ? picked : today
              refresh()
            }}
          />
        </label>
      </div>
      {r(() => {
        const shown = day.value
        const known = state.roomsOn(shown)
        const bookings = bookingsOf(known.bookings, space)
        const fetched = fetchedOf(known, space.id)
        const registrar = state.registrarRoom(space)
        const classes = registrar ? state.courses.value!.schedule.on({ room: registrar }, shown) : []
        const rows = [
          ...bookings.map(booking => ({ start: booking.start, row: <BookingRow booking={booking} /> })),
          ...classes.map(scheduled => ({ start: scheduled.event.start, row: <ClassRow scheduled={scheduled} /> }))
        ].sort((a, b) => a.start - b.start)
        return (
          <>
            {rows.length
              ? <ul class="rows">{rows.map(({ row }) => row)}</ul>
              : <p class="muted">{fetched ? <>Nothing booked here {shown === today ? "today" : <DayName day={shown} />}.</> : `Nothing from ${sourceOf(space)} yet.`}</p>}
            {!isRec && !verified.value && bookings.length > 0 && <p class="muted">Verify your UNH email in <Go to={{ kind: "you" }}>You</Go> to see what each booking is.</p>}
            {(fetched || registrar) && <p class="view-foot muted">
              {fetched ? <>{sourceOf(space)} as of {localDay(fetched) !== today && <><DayName day={localDay(fetched)} /> </>}<ClockTime at={new Date(fetched)} /></> : ""}
              {registrar && `${fetched ? " · " : ""}classes from UNH Time & Room`}
            </p>}
          </>
        )
      })}
      {isRec && <div class="lines"><LinkLine href={SCHEDULE}>Campus Rec schedule</LinkLine></div>}
    </>
  )
}

/** A room 25Live doesn't book: its classes today, as the registrar schedules them */
const ClassroomView = ({ courses, where }: { courses: Courses, where: string }) => {
  const meeting = courses.terms.flatMap(term => term.sections).flatMap(section => section.meetings).find(meeting => roomKey(meeting.where) === roomKey(where))
  const named = meeting?.where ?? where
  const place = meeting?.place
  focusOn({ kind: "room", where }, place)
  return (
    <>
      <Head kind={place ? `Room · ${place}` : "Room"} title={named} />
      {place && <Facts where={place} place={place} />}
      <div class="view-actions">
        {place && <button type="button" class="button primary" onclick={() => directions(placeNamed(place), named)}>Directions</button>}
        <button type="button" class="button" onclick={() => share(named)}>Share</button>
      </div>
      <h3 class="eyebrow">Today</h3>
      {r(() => {
        const today = courses.schedule.on({ room: named }, localDay(nowMs()))
        return today.length
          ? <ul class="rows">{today.map(scheduled => <ClassRow scheduled={scheduled} />)}</ul>
          : <p class="muted">No classes scheduled here today.</p>
      })}
      {courses.terms.length > 0 && <Source term={courses.terms[0]} extra={CLASSES_ONLY} />}
    </>
  )
}

/** A room's page: a space, at once from what's known, else the registrar's room, once the courses load */
export const RoomView = ({ where }: { where: string }) => {
  const space = spaceFor(state.spaces.peek(), where)
  return space ? <SpaceView space={space} where={where} /> : withCourses(courses => <ClassroomView courses={courses} where={where} />)
}

/** A space's row, which opens its page: how it stands, its name, or its room alone on its place's page, and what it is */
const SpaceRow = ({ found: { space, standing }, what = space.where }: { found: FoundSpace, what?: string }) =>
  <Row
    time={<StandingTime standing={standing} />}
    what={what}
    sub={aboutOf(space)}
    standing="›"
    onclick={() => state.go({ kind: "room", where: space.where })}
  />

/** Asks the Worker about the day a search asks rooms of, so what it finds is current: today, or the day of a time typed */
export const wantRoomsFor = (text: string) => {
  const asked = parseAsked(text, Date.now())
  if (asksRooms(asked))
    state.wantRooms(localDay(asked.freeAt ?? Date.now()))
}

/** The heading of search's rooms: free at the time asked, else to book. A heading is text, not elements, so its time is formatted here */
const labelOf = (freeAt: number | undefined, at: number) =>
  freeAt === undefined ? "Rooms to book" :
  freeAt - at < 60_000 ? "Free now" :
  `Free ${localDay(freeAt) === addDays(localDay(at), 1) ? "tomorrow " : ""}at ${clockOf(freeAt)}`

/** Search's rooms to book for what's typed, free ones first, followed as what's known of the day and the clock change */
export const SpaceResults = ({ query }: { query: DerivativeNode<string> }) =>
  r(() => {
    const text = query.value.trim()
    if (!text)
      return null
    const at = state.now.value * 1000
    const { asked, found, matched } = state.searchSpaces.value(text, at, state.roomStanding)
    if (!found.length)
      return asked.freeAt !== undefined && matched > 0 && <Group label={labelOf(asked.freeAt, at)}><li><p class="muted">None free then.</p></li></Group>
    return <Group label={labelOf(asked.freeAt, at)}>{found.map(found => <SpaceRow found={found} />)}</Group>
  })

/** How many spaces at a place are listed before the rest wait behind a tap */
const SHOWN = 4

/**
 * The spaces at a place, for its page: Dimond's study rooms, Hamel's courts and studios, free ones first, each
 * opening its own page, a few at first and the rest on a tap; a field that's a space of its own is its one schedule
 */
export const SpacesHere = ({ name }: { name: string }) => {
  const all = r(false)
  return r(() => {
    const here = state.spaces.value.filter(space => space.place === name)
    if (!here.length)
      return null
    const at = state.now.value * 1000
    const found = here.map(space => ({ space, standing: state.roomStanding(space, at) }))
      .sort((a, b) => +b.standing.isFree - +a.standing.isFree || a.space.where.localeCompare(b.space.where, "en", { numeric: true }))
    const source = sourceOf(found[0].space)
    if (found.length === 1 && found[0].space.room === "")
      return <>
        <h3 class="eyebrow">{source}</h3>
        <ul class="rows"><SpaceRow found={found[0]} what="Today's schedule" /></ul>
      </>
    const free = found.filter(({ standing }) => standing.isFree).length
    return (
      <>
        <h3 class="eyebrow">{source === "25Live" ? "Rooms to book" : source} · {free ? `${free} free now` : "none free now"}</h3>
        <ul class="rows">{(all.value ? found : found.slice(0, SHOWN)).map(found => <SpaceRow found={found} what={found.space.room} />)}</ul>
        {found.length > SHOWN && !all.value && <button type="button" class="more" onclick={() => all.value = true}>All {found.length} ›</button>}
      </>
    )
  })
}
