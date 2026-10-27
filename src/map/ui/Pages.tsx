/** @jsxImportSource bruh/browser */

// The pages the sheet shows over the home, each at a link of its own (link.mts): a section, which leads with its
// next meeting; an instructor, with their next scheduled class and their week; a room, with what's scheduled there
// today; a course, with what it needs and unlocks, the programs naming it, and its sections, the next term's too; a
// place, with what's on there, the stop beside it and its own facts; an event, with Going for one made here; parking
// near a place, and a parking area (Parking.tsx); a program, a planning view of its own (Program.tsx); a stop and a
// bus (StopView.tsx, BusView.tsx); directions (Directions.tsx); a new event (NewEvent.tsx); you (You.tsx); and the
// buses (Buses.tsx). Each offers Directions and Remind for the visit it leads with, which need nothing saved, and
// where to park for it, and says where it is, which the map marks. What's said of a person is their scheduled
// teaching from the registrar's sections, and of a room its classes, which never make it free

import type { BruhChild } from "bruh/browser"
import { type DerivativeNode, type SourceNode, r } from "bruh/reactive"
import type { Page } from "../link.mts"
import { urlOf } from "../link.mts"
import { state } from "../state/map.mts"
import { type CourseEvent, type Meeting, type Section, type Term, KINDS, codeOf, courseOf, registrarUrl, standing } from "../../courses/course.mts"
import type { Courses } from "../../courses/browser/terms.mts"
import { type Person, nextTeaching } from "../../courses/people.mts"
import { roomKey } from "../../courses/rooms.mts"
import { mailto } from "../../courses/email.mts"
import { type Dated, datedFrom, daysOf, isSaved, keyOf, patternsOf } from "../../courses/saved.mts"
import { reqsOf } from "../../programs/prereqs.mts"
import { type Event, type Pin, type Source as EventSource, LINGER, placeOf, upcoming, whereOf } from "../../social/event.mts"
import { isUnset } from "../../social/marks.mts"
import { askOf } from "../../social/ask.mts"
import * as social from "../../social/browser/api.mts"
import { share as shareStory } from "../../social/story.mts"
import { type Act, Going, Moderate, SHARED, Times } from "../../social/ui.tsx"
import { status as hallStatus, wallDate } from "../../dining/hours.mts"
import type { Summaries } from "../../laundry/infer.mts"
import { getJson } from "../../shared/json.mts"
import { boardableStops } from "../../transit/feed.mts"
import { distance } from "../../geo/projection.mts"
import { walkSeconds } from "../../routing/walks.mts"
import { type Occurrence, type Visit, thereBy, visitOf } from "../../shared/visit.mts"
import { clockOf, daysBetween, localDay, localMinutes, nextAt } from "../../shared/time.mts"
import type { Place } from "../../places/search.mts"
import { ClockRange, ClockTime, Count, Counted, Day, DayRange, List, Minutes, Weekdays, relativeDay } from "../../shell/intl.tsx"
import { capture } from "../../shell/usage.tsx"
import { minutes, nowMs, walkTo } from "./common.tsx"
import { ArrivalOffset, Remind } from "./Remind.tsx"
import { AreaPageView, ParkingView, parkingFor } from "./Parking.tsx"
import { roomAtSlug } from "../../laundry/rooms.mts"
import { Group } from "./Courses.tsx"
import { ProgramView, ProgramsLine } from "./Program.tsx"
import { RouteBadge } from "./common.tsx"
import { Soon, StopView, departuresFrom } from "./StopView.tsx"
import { BusView } from "./BusView.tsx"
import { DirectionsView } from "./Directions.tsx"
import { NewEventView } from "./NewEvent.tsx"
import { YouView } from "./You.tsx"
import { BusesView } from "./Buses.tsx"
import { NewEvent } from "./Home.tsx"

/** A notice for the page shown, like a link copied */
const notice = r<string>()

/** The pins opened that aren't on today's list, each read from the Worker once */
const pins = new Map<string, Promise<Pin | undefined>>()
const pinOf = (id: string) => {
  if (!pins.has(id))
    pins.set(id, social.pin(id).catch(() => undefined))
  return pins.get(id)!
}

/** An event by its id: one of the build's or on today's list as they are, else a pin as the Worker has it, or none */
const eventOf = async (id: string): Promise<Event | Pin | undefined> =>
  [...state.todayList.peek(), ...state.events.peek().events].find(event => event.id === id) ?? pinOf(id)

/** Minutes after midnight on Durham's clock as a range, "2:10 – 3:30 PM", as the registrar's patterns are */
export const Hours = ({ start, end }: Pick<Meeting, "start" | "end">) =>
  <ClockRange from={new Date(start * 60_000)} to={new Date(end * 60_000)} timeZone="UTC" />

/** A Durham day as a row says it: "Today", "Tomorrow", or "Thu" */
export const DayName = ({ day }: { day: string }) => {
  const away = daysBetween(localDay(nowMs()), day)
  return away >= 0 && away < 2 ? <>{relativeDay(away)}</> : <Day of={day} weekday="short" />
}

/** When an occurrence is: "Today 2:10 – 3:30 PM", "Thu 2:10 – 3:30 PM" */
export const When = ({ start, end }: Pick<Occurrence, "start" | "end">) =>
  <><DayName day={localDay(start)} /> <ClockRange from={new Date(start)} to={new Date(end)} /></>

/** An occurrence's hours as a row's time column says them: "2:10" over "– 3:30 PM" */
export const Span = ({ start, end }: Pick<Occurrence, "start" | "end">) =>
  <><ClockTime at={new Date(start)} /><small>– <ClockTime at={new Date(end)} /></small></>

/** A place by its name: the gazetteer's, else a laundry or dining building's */
export const placeNamed = (name: string | undefined) =>
  placeOf(state.gazetteer.peek(), name) ?? state.buildings.peek().find(building => building.name === name)

/** Where a page is, marked on the map while it's shown: a place, by name, and when, as an occurrence there begins */
const focusOn = (page: Page, name: string | undefined, at?: number) => {
  const place = placeNamed(name)
  // A map label is text the map draws, not elements, so its time is formatted here
  state.focusAt(page, place && { place, label: at === undefined ? place.name : `${place.name} · ${clockOf(at)}` })
}

/** Directions to a place from where you are, leaving now, in place of any trip planned */
const directNow = (place: Place) => {
  state.from.value = undefined
  state.by.value = undefined
  void state.directTo(place)
  return true
}

/**
 * Directions, from where you are: for a visit, there by its time less its offset, or to a place, leaving now; and
 * their page shown, from which Back returns to the page
 */
export const directions = (to: Visit | Place | undefined, what: string) => {
  if (to && ("destination" in to ? state.planVisit(to) : directNow(to))) {
    capture("visit_planned")
    state.go({ kind: "directions" })
  }
  else
    notice.value = `${what} is nowhere the map knows.`
}

/** The system's share sheet with the page's link, or the link copied where there's none */
export const share = (title: string) => {
  const url = location.origin + urlOf(state.page.peek())
  ;(navigator.share?.({ title, url }) ?? navigator.clipboard?.writeText(url).then(() => notice.value = "Link copied."))?.catch(() => {})
}

/** A page's head: its name, which a Back to it says, short where the title's long, over what kind of thing it is where the title alone doesn't say */
export const Head = ({ kind, title, name }: { kind?: BruhChild, title: string, name?: string }) => {
  state.name.value = name ?? title
  return (
    <header class="view-head">
      {kind && <p class="view-kind">{kind}</p>}
      <h2>{title}</h2>
    </header>
  )
}

/** A row of a page's list: when, what and where, and how it stands, which a tap opens, and beside it what else it offers */
export const Row = ({ time, what, sub, standing, onclick, aside }: { time?: BruhChild, what: BruhChild, sub?: BruhChild, standing?: BruhChild, onclick?: () => void, aside?: BruhChild }) =>
  <li>
    <button type="button" class="row" onclick={onclick}>
      {time !== undefined && <span class="row-time">{time}</span>}
      <span class="row-what">
        <strong class="truncate">{what}</strong>
        {sub && <span class="muted truncate">{sub}</span>}
      </span>
      {standing && <span class="row-state">{standing}</span>}
    </button>
    {aside}
  </li>

/** A labelled line of a page: what it is, and its value or where it goes */
export const Line = ({ label, children }: { label: BruhChild, children?: BruhChild }) =>
  <div class="line">
    <span>{label}</span>
    <span class="line-value">{children}</span>
  </div>

/** A link within a page to another page */
export const Go = ({ to, children }: { to: Page, children?: BruhChild }) =>
  <button type="button" class="go" onclick={() => state.go(to)}>{children}</button>

/** A line that is a link on, to a page, an address, or whatever a tap does, named by what it leads to: "Parking ›" */
export const LinkLine = ({ to, href, onclick, children }: { to?: Page, href?: string, onclick?: () => void, children?: BruhChild }) =>
  href !== undefined
    ? <a class="line link-line" href={href} {...href.startsWith("/") ? {} : { target: "_blank", rel: "noopener" }}><span>{children}</span><span>›</span></a>
    : <button type="button" class="line link-line" onclick={onclick ?? (() => state.go(to!))}><span>{children}</span><span>›</span></button>

/** The room alone, "N343", where a page has already said the building */
export const roomOf = (where: string) =>
  where.split(" ").at(-1) ?? where

/** The person a section's instructor is, by the id people are kept by */
const personPage = ({ name, mail }: { name: string, mail?: string }): Page =>
  ({ kind: "person", id: mail ?? name })

/**
 * A section's credits as the registrar gives them, "4.0" as "4 credits"; a range, "1.0-4.0", as its own words, as
 * its count isn't one number to say the plural of
 */
const Credits = ({ credits }: { credits: string }) =>
  /^\d+(\.\d+)?$/.test(credits) ? <Counted value={+credits} one="credit" other="credits" /> : <>{credits.replace(/\.0\b/g, "")} credits</>

/** A section's page */
export const sectionPage = (term: Pick<Term, "code">, section: Pick<Section, "crn">): Page =>
  ({ kind: "section", term: term.code, crn: section.crn })

/** A meeting's weekdays, as a pattern says them: "Tue Thu" */
const Days = ({ days }: { days: string }) =>
  <Weekdays days={daysOf(days)} style="narrow" />

/** A section's weekly patterns as its time column says them: "Tue Thu" over "2:10 – 3:30 PM" */
const Pattern = ({ section }: { section: Section }) => {
  const [first] = patternsOf(section)
  return first ? <><Days days={first.days} /><small><Hours {...first} /></small></> : <>Arranged</>
}

/** Where a section meets, its first room, then any other in words: "Kingsbury N343 · Fri in N113" */
const Where = ({ section }: { section: Section }) => {
  const [first, ...rest] = patternsOf(section)
  return first
    ? <>{first.where}{rest.filter(({ where }) => where !== first.where).map(({ days, where }) => <> · <Days days={days} /> in {roomOf(where)}</>)}</>
    : <>{section.meetings[0]?.where ?? ""}</>
}

const Loading = () =>
  r(() => <p class="muted">{state.coursesFailed.value ? "The courses couldn't load. Try again once online." : "Loading courses…"}</p>)

/** The courses, once loaded, to show a page of */
const withCourses = (show: (courses: Courses) => BruhChild) =>
  r(() => state.courses.value ? show(state.courses.value) : <Loading />)

const Missing = ({ what, why = "Not in the terms notunh has now." }: { what: string, why?: string }) =>
  <>
    <Head title={what} />
    <p class="muted">{why}</p>
  </>

/** Where to go, how long it takes from here, and when to leave to be there in time, as a page's facts say */
const Facts = ({ where, place, visit, extra }: { where: string, place?: string, visit?: Visit, extra?: string }) =>
  r(() => {
    const walk = walkTo(placeNamed(place))
    return (
      <p class="view-facts">
        <strong>{where}</strong>
        {extra && ` · ${extra}`}
        {walk !== undefined && <> · <Minutes value={minutes(walk)} /> walk</>}
        {walk !== undefined && visit && thereBy(visit) - walk * 1000 > nowMs() && <> · leave by <ClockTime at={new Date(thereBy(visit) - walk * 1000)} /></>}
      </p>
    )
  })

/** A class's place on the map, from the meeting, or else the section's first placed meeting */
const placeOfSection = (section: Section, event?: CourseEvent) =>
  event?.place ?? section.meetings.find(({ place }) => place)?.place

/** What a course needs and unlocks, the unlocks as links to their pages, while the prerequisites load */
const Needs = ({ code }: { code: string }) =>
  r(() => {
    const prereqs = state.prereqs.value
    if (!prereqs)
      return <Line label="Needs · Unlocks"><span class="muted">…</span></Line>
    const { needs, unlocks } = reqsOf(prereqs, code)
    return (
      <Line label="Needs · Unlocks">
        <span>
          <span class="muted">{needs || "None listed"}</span>
          {unlocks.length > 0 && <> · {unlocks.map((unlocked, i) => <>{i > 0 && ", "}<Go to={{ kind: "course", code: unlocked }}>{unlocked}</Go></>)}</>}
        </span>
      </Line>
    )
  })

/** When the registrar's data was read, and what else a page's foot says */
const Source = ({ term, extra }: { term: Pick<Term, "fetched">, extra?: BruhChild }) =>
  <p class="view-foot muted">UNH Time &amp; Room, fetched <Day of={localDay(term.fetched)} month="short" day="numeric" />{extra}</p>

/** What a list of a room's classes leaves unsaid, as the registrar schedules classes alone */
const CLASSES_ONLY = " · classes only; a room with none may still be booked"

const SectionView = ({ courses, term, section }: { courses: Courses, term: Term, section: Section }) => {
  const key = keyOf(term.code, section.crn)
  const found = { term, section }
  /** The meeting under way, else the next, which is what Directions and Remind are for */
  const next = r(() => {
    const { current, next } = standing(term, section, courses.calendar, nowMs())
    return current ?? next
  })
  const nextId = r(() => next.value?.id)
  const saved = r(() => isSaved(state.savedKeys.value, found))
  const finals = courses.calendar.terms[term.code]?.finals
  const place = placeOfSection(section)
  return (
    <>
      <Head
        kind={<><Go to={{ kind: "course", code: courseOf(section) }}>{codeOf(section)}</Go> · {KINDS[section.kind] ?? section.kind} · <Credits credits={section.credits} /> · {term.name}</>}
        title={section.title}
        name={codeOf(section)}
      />
      {r(() => {
        void nextId.value
        const event = next.peek()
        focusOn(sectionPage(term, section), event?.place ?? place, event?.start)
        if (!event)
          return <p class="muted">No more meetings this term.</p>
        const visit = visitOf(event)
        return (
          <div>
            <p class="view-label">{event.start <= nowMs() ? "Now" : "Next"}</p>
            <p class="view-when"><When {...event} /></p>
            <Facts where={event.where} place={event.place} visit={visit} />
          </div>
        )
      })}
      <div class="view-actions">
        {r(() => next.value?.place && <button type="button" class="button primary" onclick={() => directions(next.peek() && visitOf(next.peek()!), codeOf(section))}>Directions</button>)}
        <button type="button" class="button" aria-pressed={r(() => String(saved.value))} onclick={() => saved.peek() ? state.unsave(found) : state.save(found)}>
          {r(() => saved.value ? "Saved" : "Save")}
        </button>
        <button type="button" class="button" onclick={() => share(codeOf(section))}>Share</button>
      </div>
      <div class="lines">
        <Line label="Weekly">
          {patternsOf(section).map(meeting => <span class="muted"><Days days={meeting.days} /> <Hours {...meeting} /> · {meeting.place === place ? roomOf(meeting.where) : meeting.where}</span>)}
          <span class="muted">to <Day of={section.to} month="short" day="numeric" /></span>
        </Line>
        {section.instructors.map(instructor => <Line label="Instructor"><Go to={personPage(instructor)}>{instructor.name} ›</Go></Line>)}
        {r(() => {
          void nextId.value
          const visit = next.peek() && visitOf(next.peek()!)
          // For this class, meeting after meeting (src/reminders/queue.mts), saved or not
          return visit && (
            <div class="line remind-line">
              <span>Reminder</span>
              <Remind visit={visit} offset={r(0)} section={{ id: key, resolve: state.resolveClass }} />
            </div>
          )
        })}
        <Needs code={courseOf(section)} />
        <Line label="Seats, restrictions"><a class="go" href={registrarUrl(term.code, section.crn)} target="_blank" rel="noopener">Course Search ›</a></Line>
        {place && <LinkLine to={{ kind: "place", name: place }}>{place}</LinkLine>}
        {r(() => {
          void nextId.value
          const visit = next.peek() && visitOf(next.peek()!)
          return visit && <LinkLine to={parkingFor(visit)}>Parking</LinkLine>
        })}
      </div>
      <Source term={term} extra={<> · CRN {section.crn}{finals && <> · finals <DayRange from={finals[0]} to={finals[1]} /></>}</>} />
    </>
  )
}

const PersonView = ({ courses, person }: { courses: Courses, person: Person }) => {
  const offset = r(0)
  const teaching = r(() => nextTeaching(person, courses.calendar, nowMs()))
  const nextId = r(() => teaching.value.next?.id)
  const codes = [...new Set(person.teaching.map(({ section }) => courseOf(section)))]
  return (
    <>
      <Head kind={<>Instructor · <List type="unit" items={codes} /></>} title={person.name} />
      {r(() => {
        void nextId.value
        const { current, next } = teaching.peek()
        focusOn({ kind: "person", id: person.id }, next?.place ?? current?.place, next?.start)
        return (
          <div>
            {current && <p class="muted">Now: {courseOf(current.section)} in {current.where}, till <ClockTime at={new Date(current.end)} /></p>}
            <p class="view-label">Next</p>
            {next
              ? <NextClass next={next} offset={offset} />
              : <p class="muted">No more classes scheduled this term.</p>}
          </div>
        )
      })}
      <Week person={person} courses={courses} />
      {person.mail && <div class="lines"><LinkLine onclick={() => location.href = mailto(person.mail!)}>Email</LinkLine></div>}
      {courses.terms.length > 0 && <Source term={courses.terms[0]} extra=" · scheduled teaching only" />}
    </>
  )
}

/**
 * What a page offers for the visit it leads with: when to be there, Directions with when to leave for that, whatever
 * else goes beside it, and Remind, which shares the offset
 */
const VisitActions = ({ visit, offset, what, children }: { visit: Visit, offset: SourceNode<number>, what: string, children?: BruhChild }) =>
  <>
    <ArrivalOffset offset={offset} at={visit.arriveBy} />
    <div class="view-actions">
      <button type="button" class="button primary" onclick={() => directions({ ...visit, offset: offset.peek() }, what)}>
        Directions{r(() => {
          const walk = walkTo(placeNamed(visit.destination.place))
          const leave = walk === undefined ? undefined : thereBy({ ...visit, offset: offset.value }) - walk * 1000
          return leave !== undefined && leave > nowMs() && <> · leave <ClockTime at={new Date(leave)} /></>
        })}
      </button>
      {children}
    </div>
    <Remind visit={visit} offset={offset} />
  </>

/** A person's next class: when, where, and what to do about getting there */
const NextClass = ({ next, offset }: { next: CourseEvent & { section: Section }, offset: SourceNode<number> }) => {
  const visit = visitOf(next)
  const minutesAway = Math.round((next.start - nowMs()) / 60_000)
  return (
    <>
      {/* bruh has no relative time element: "in" is said here, and the minutes are its number's */}
      <p class="view-when"><When {...next} />{minutesAway < 60 && <span class="muted"> · in <Minutes value={Math.max(1, minutesAway)} /></span>}</p>
      <Facts where={next.where} place={next.place} extra={codeOf(next.section)} />
      {visit && <VisitActions visit={visit} offset={offset} what={codeOf(next.section)} />}
    </>
  )
}

/** Every class a person is scheduled to teach in the coming week, and their sections that don't meet in it */
const Week = ({ person, courses }: { person: Person, courses: Courses }) =>
  r(() => {
    const live = person.teaching.filter(({ term }) => courses.terms.includes(term))
    const week = datedFrom(live, courses.calendar, nowMs())
    const quiet = live.filter(({ section }) => !week.some(dated => dated.section === section))
    return (
      <>
        <h3 class="eyebrow">This week</h3>
        {week.length
          ? <ul class="rows">{week.map(dated => <ClassRow dated={dated} />)}</ul>
          : <p class="muted">No classes scheduled this week.</p>}
        {quiet.length > 0 && <>
          <h3 class="eyebrow">Also teaching</h3>
          <ul class="rows">{quiet.map(({ term, section }) => <SectionRow term={term} section={section} />)}</ul>
        </>}
      </>
    )
  })

/** A dated class as a row: its day and time, its section, and its room, said to differ where it isn't the usual */
const ClassRow =({ dated: { event, term, section } }: { dated: Dated }) => {
  const usual = patternsOf(section)[0]?.where
  return (
    <Row
      time={<><DayName day={localDay(event.start)} /><small><ClockRange from={new Date(event.start)} to={new Date(event.end)} /></small></>}
      what={codeOf(section)}
      sub={event.where === usual ? event.where : `${event.where} · different room`}
      onclick={() => state.go(sectionPage(term, section))}
    />
  )
}

/** A section as a row: its weekly pattern, its code and title, where it meets, and its CRN */
export const SectionRow = ({ term, section, aside }: { term: Term, section: Section, aside?: BruhChild }) =>
  <Row
    aside={aside}
    time={<Pattern section={section} />}
    what={`${codeOf(section)} · ${section.title}`}
    sub={<Where section={section} />}
    standing={section.crn}
    onclick={() => state.go(sectionPage(term, section))}
  />

const RoomView = ({ courses, where }: { courses: Courses, where: string }) => {
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
          ? <ul class="rows">{today.map(({ term, section, event, also }) =>
              <Row
                time={<Span {...event} />}
                what={<List type="unit" items={[section, ...also].map(courseOf)} />}
                sub={section.title}
                standing={event.end <= nowMs() ? "ended" : event.start <= nowMs() ? "now" : undefined}
                onclick={() => state.go(sectionPage(term, section))}
              />
            )}</ul>
          : <p class="muted">No classes scheduled here today.</p>
      })}
      {courses.terms.length > 0 && <Source term={courses.terms[0]} extra={CLASSES_ONLY} />}
    </>
  )
}

/** A term's sections of a course, or that it isn't offered, which a term to come leaves unsaid */
const Offered = ({ term, code, isLater }: { term: Term, code: string, isLater?: boolean }) => {
  const sections = term.sections.filter(section => courseOf(section) === code)
  return (!isLater || sections.length > 0) && (
    <>
      <h3 class="eyebrow">{term.name}</h3>
      {sections.length
        ? <ul class="rows">{sections.map(section => <SectionRow term={term} section={section} />)}</ul>
        : <p class="muted">Not offered.</p>}
    </>
  )
}

/** A course's page: what it needs and unlocks, and its sections in each live term, then in the terms to come as they load */
const CourseView = ({ courses, code }: { courses: Courses, code: string }) => {
  state.wantLater()
  const title = courses.terms.flatMap(term => term.sections).find(section => courseOf(section) === code)?.title
  return (
    <>
      <Head title={title ? `${code} · ${title}` : code} name={code} />
      <div class="lines">
        <Needs code={code} />
        <ProgramsLine code={code} />
      </div>
      {courses.terms.map(term => <Offered term={term} code={code} />)}
      {r(() => state.later.value?.map(term => <Offered term={term} code={code} isLater />) ?? (state.laterTerms.value.length > 0 && <p class="muted">Loading <List items={state.laterTerms.value.map(({ name }) => name)} />…</p>))}
      {courses.terms.length > 0 && <Source term={courses.terms[0]} />}
    </>
  )
}

/**
 * An event as a row: when, its day too where it isn't on the day the row's under, or that its time's still to pick,
 * what, and where, which opens its page
 */
export const EventRow = ({ event, day = localDay(nowMs()), standing }: { event: Event | Pin, day?: string, standing?: BruhChild }) =>
  <Row
    time={
      isUnset(event)               ? "To pick" :
      localDay(event.start) === day ? <Span {...event} /> :
                                      <><DayName day={localDay(event.start)} /><small><ClockTime at={new Date(event.start)} /></small></>
    }
    what={event.title}
    sub={whereOf(event)}
    standing={standing}
    onclick={() => state.go({ kind: "event", id: event.id })}
  />

/** How many events search lists */
const FOUND = 5

/** Search's events: those still to come whose title or place has every word typed, soonest first */
export const EventResults = ({ query }: { query: DerivativeNode<string> }) =>
  r(() => {
    const words = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(word => word.length > 1)
    if (!words.length)
      return null
    const now = nowMs()
    const events = [...new Map([...state.events.value.events, ...state.todayList.value].map(event => [event.id, event])).values()]
    const found = events
      .filter(event => event.end + LINGER > now && words.every(word => `${event.title} ${event.place ?? ""} ${event.where}`.toLocaleLowerCase().includes(word)))
      .sort((a, b) => a.start - b.start)
      .slice(0, FOUND)
    return found.length > 0 && <Group label="Events">{found.map(event => <EventRow event={event} />)}</Group>
  })

/** How many days ahead a place's week looks */
const WEEK = 7

/** The dining hall a place is, by name, with its hours, where the menus know it */
const hallOf = (name: string) => {
  const menus = state.menus.value
  const hall = menus.halls.find(hall => hall.name === name)
  const hours = hall && menus.hours[hall.id]
  return hours && { hall, hours }
}

/** A dining hall's standing now: "open till 8:00 PM", or "opens 11:00 AM", or "closed today" */
const HallHours = ({ name }: { name: string }) =>
  r(() => {
    const found = hallOf(name)
    if (!found)
      return null
    const at = nowMs()
    const standing = hallStatus(found.hours, { day: localDay(at), minute: localMinutes(at) })
    return (
      standing.isOpen ? <>open till <ClockTime at={wallDate(standing.closes)} timeZone="UTC" /></> :
      standing.opens  ? <>opens {localDay(at) !== standing.opens.day && <><Day of={standing.opens.day} weekday="short" /> </>}<ClockTime at={wallDate(standing.opens)} timeZone="UTC" /></> :
                        <>closed</>
    )
  })

/** Every laundry room's counts, asked for once a place with rooms is opened, and kept for the visit */
let laundry: Promise<Summaries | undefined> | undefined
const laundryCounts = () =>
  laundry ??= getJson<Summaries>("/api/laundry/rooms").catch(() => undefined)

/** What a laundry or dining building offers, inline: the hall's hours and its menus, or each room's machines free and the room */
const Building = ({ name }: { name: string }) => {
  const building = state.buildings.peek().find(building => building.name === name)
  if (!building)
    return null
  if (building.kind === "dining")
    return <LinkLine href="/dining/">Menus<span class="muted"> · <HallHours name={name} /></span></LinkLine>
  const counts = r<Summaries>()
  void laundryCounts().then(found => counts.value = found)
  return building.rooms?.map(room => {
    const id = roomAtSlug(room)?.id
    return (
      <LinkLine href={`/laundry/${room}/`}>
        Laundry{building.rooms!.length > 1 && ` · ${roomAtSlug(room)?.name ?? room}`}
        {r(() => {
          const summary = id === undefined ? undefined : counts.value?.rooms[id]
          return summary && <span class="muted"> · <Count value={summary.washer.free} /> washers, <Count value={summary.dryer.free} /> dryers free</span>
        })}
      </LinkLine>
    )
  })
}

/** How far a stop may be to count as a place's own */
const NEARBY_M = 400

/** The stop nearest a place that buses pick up at, and its next departures in brief, which opens the stop */
const NearestStop = ({ place }: { place: Place }) =>
  r(() => {
    const feed = state.feed.value
    const boardable = boardableStops(feed)
    const nearest = feed.stops
      .map((stop, index) => ({ stop, index, meters: distance(place, stop) }))
      .filter(({ index, meters }) => boardable.has(index) && meters <= NEARBY_M)
      .sort((a, b) => a.meters - b.meters)[0]
    if (!nearest)
      return null
    const departures = departuresFrom(nearest.index)
    return (
      <>
        <h3 class="eyebrow">Nearby</h3>
        <ul class="rows">
          <Row
            what={nearest.stop.name}
            sub={r(() => departures.value.length
              ? <span class="nearby-buses">{departures.value.slice(0, 3).map(({ route, shown, wait }) => <span><RouteBadge route={route} /> {shown[0] ? <Soon time={shown[0].time} /> : wait && <>every <Minutes value={minutes(wait.headway)} /></>}</span>)}</span>
              : "No buses in the next few hours"
            )}
            standing={<><Minutes value={minutes(walkSeconds(nearest.meters))} /> walk</>}
            onclick={() => state.go({ kind: "stop", id: nearest.stop.id })}
          />
        </ul>
      </>
    )
  })

/**
 * A place's page: its facts, Directions, what's on there today and this week, with a new event as the last row,
 * the stop beside it and what it offers itself, the classes under way, a reminder to leave to be there by a time,
 * and parking
 */
const PlaceView = ({ name }: { name: string }) => {
  const place = placeNamed(name)
  if (!place)
    return <Missing what={name} why="Nowhere the map knows." />
  focusOn({ kind: "place", name }, name)
  const by = r<number>()
  const time: HTMLInputElement = <input type="time" aria-label="Be there by" onchange={() => by.value = time.value ? nextAt(time.value, nowMs()) : undefined} />
  return (
    <>
      <Head title={name} />
      {r(() => {
        const walk = walkTo(place)
        const hall = hallOf(name)
        return (walk !== undefined || hall) && <p class="view-facts"><List type="unit" items={[...hall ? ["Dining hall"] : [], ...walk !== undefined ? [<><Minutes value={minutes(walk)} /> walk</>] : [], ...hall ? [<HallHours name={name} />] : []]} /></p>
      })}
      <div class="view-actions">
        <button type="button" class="button primary" onclick={() => directions(place, name)}>Directions</button>
        <button type="button" class="button" onclick={() => share(name)}>Share</button>
      </div>
      {r(() => {
        const here = state.todayList.value.filter(event => event.place === name)
        const week = upcoming(state.events.value.events.filter(event => event.place === name), nowMs(), WEEK).flatMap(({ day, events }) => events.map(event => ({ day, event })))
        return <>
          {here.length > 0 && <>
            <h3 class="eyebrow">Here today</h3>
            <ul class="rows">{here.map(event => <EventRow event={event} />)}</ul>
          </>}
          <h3 class="eyebrow">This week</h3>
          <ul class="rows">
            {week.map(({ event }) => <EventRow event={event} day="" />)}
            <NewEvent place={name} />
          </ul>
        </>
      })}
      <NearestStop place={place} />
      <ScheduledNow name={name} />
      <div class="lines">
        <Building name={name} />
        <div class="line remind-line place-by">
          <label>Remind me to leave for here by</label>
          {time}
          {r(() => by.value !== undefined && <Remind visit={{ destination: { place: name, where: "" }, arriveBy: by.value, offset: 0 }} offset={r(0)} />)}
        </div>
        <LinkLine to={{ kind: "parking", place: name }}>Parking</LinkLine>
      </div>
    </>
  )
}

/**
 * The rooms of a place with a class under way, collapsed: each room and its class, when it ends, and what's next in
 * it today. Rooms, never a count of people, and a room with nothing on isn't said to be free
 */
const ScheduledNow = ({ name }: { name: string }) =>
  r(() => {
    const courses = state.courses.value
    if (!courses)
      return null
    const at = nowMs()
    const under = courses.schedule.now({ place: name }, at)
    if (!under.length)
      return null
    return (
      <details class="view-group">
        <summary><span class="eyebrow">Classes now · <Counted value={under.length} one="room" other="rooms" /></span></summary>
        <ul class="rows">{under.map(({ term, section, meeting, event, also }) => {
          const then = courses.schedule.on({ room: meeting.where }, localDay(at)).find(({ event: later }) => later.start >= event.end)
          return (
            <Row
              time={<Span {...event} />}
              what={<>{roomOf(meeting.where)} · <List type="unit" items={[section, ...also].map(courseOf)} /></>}
              sub={<>ends in <Minutes value={minutes((event.end - at) / 1000)} />{then && <> · then {courseOf(then.section)} at <ClockTime at={new Date(then.event.start)} /></>}</>}
              onclick={() => state.go(sectionPage(term, section))}
            />
          )
        })}</ul>
        {courses.terms.length > 0 && <Source term={courses.terms[0]} extra={CLASSES_ONLY} />}
      </details>
    )
  })

/** Where an event's source is, in its own name, for its page's foot */
const SOURCES: Record<Exclude<EventSource, "pin" | "course">, string> = { presence: "Wildcat Link", "25live": "UNH Events Calendar", athletics: "UNH Athletics", dserec: "Campus Rec sport clubs" }

/**
 * An event: when and where, Directions and Remind for getting there by its start, and for one made here, its
 * description, Going, the times to pick while its time is unset, its story to share, and deleting or reporting it;
 * for UNH's, where it's from, as a line in the foot
 */
const EventView = ({ id }: { id: string }) => {
  const found = r<Event | Pin | null>()
  const offset = r(0)
  eventOf(id).then(event => found.value = event ?? null)
  const act: Act = f => () => {
    notice.value = undefined
    f().then(result => result && (found.value = result), (error: Error) => notice.value = error.message)
  }
  return r(() => {
    if (found.value === undefined)
      return <p class="muted">Loading the event…</p>
    if (found.value === null)
      return <Missing what="This event is gone." why="It may have ended, or been taken down." />
    const event = found.value
    const pin = event.source === "pin" ? event as Pin : undefined
    const unset = isUnset(event)
    const visit = unset ? undefined : visitOf(event)
    focusOn({ kind: "event", id }, event.place, visit && event.start)
    const isAsked = pin && !unset && !pin.isGoing && pin.chosen !== undefined && (pin.marked?.includes(pin.chosen) ?? false)
    const shareIt = () => pin
      ? shareStory(pin, location.origin).then(how => notice.value = SHARED[how], (error: Error) => error.name === "AbortError" ? undefined : notice.value = error.message)
      : share(event.title)
    const actions = <>
      {pin && !unset && <Going pin={pin} act={act} />}
      <button type="button" class="button" onclick={shareIt}>Share</button>
    </>
    return (
      <>
        <Head kind={pin && <>A UNH student{pin.spots !== undefined && <> · <Counted value={pin.spots} one="spot" other="spots" /></>}</>} title={event.title} />
        <p class="view-when">{unset ? "Time to pick" : <When {...event} />}</p>
        <Facts where={whereOf(event)} place={event.place} />
        {isAsked && <p class="ask" role="status">{askOf(pin).title}</p>}
        {visit
          ? <VisitActions visit={visit} offset={offset} what={event.title}>{actions}</VisitActions>
          : <div class="view-actions">{actions}</div>}
        {pin?.description && <p class="view-body">{pin.description}</p>}
        {pin && unset && <Times pin={pin} act={act} />}
        <div class="lines">
          {event.place && <LinkLine to={{ kind: "place", name: event.place }}>{event.place}</LinkLine>}
          {visit && <LinkLine to={parkingFor(visit)}>Parking</LinkLine>}
          {!pin && <LinkLine href={event.url}>{SOURCES[event.source as keyof typeof SOURCES] ?? "Source"}</LinkLine>}
        </div>
        {pin && <p class="view-foot muted"><Moderate pin={pin} act={act} onGone={() => found.value = null} onReported={hidden => notice.value = hidden ? "Reported, and hidden." : "Reported."} /></p>}
      </>
    )
  })
}

/** The kinds of page that read the courses as they open, so those load as the page does */
const COURSE_PAGES: Page["kind"][] = ["section", "person", "room", "course", "place"]

/** The page shown, of whichever kind, with the courses loaded for those that need them */
export const PageView = ({ page }: { page: Page }) => {
  if (COURSE_PAGES.includes(page.kind))
    state.wantCourses()
  if (page.kind === "section" || page.kind === "course")
    state.wantPrereqs()
  notice.value = undefined
  return (
    <section class={page.kind === "program" ? "view program-view" : "view"}>
      {page.kind === "section" ? withCourses(courses => {
          // A section of a term still to come, once those load
          const isLater = !courses.terms.some(term => term.code === page.term) && state.laterTerms.peek().some(term => term.code === page.term)
          if (isLater)
            state.wantLater()
          const term = (isLater ? state.later.value ?? [] : courses.terms).find(term => term.code === page.term)
          const section = term?.sections.find(section => section.crn === page.crn)
          return term && section ? <SectionView courses={courses} term={term} section={section} /> :
            isLater && !state.later.value ? <p class="muted">Loading the term…</p> :
            <Missing what={`CRN ${page.crn}`} />
        }) :
        page.kind === "person" ? withCourses(courses => {
          const person = courses.people.find(person => person.id === page.id)
          return person ? <PersonView courses={courses} person={person} /> : <Missing what="That instructor" />
        }) :
        page.kind === "room"       ? withCourses(courses => <RoomView courses={courses} where={page.where} />) :
        page.kind === "course"     ? withCourses(courses => <CourseView courses={courses} code={page.code} />) :
        page.kind === "place"      ? <PlaceView name={page.name} /> :
        page.kind === "parking"    ? <ParkingView page={page} /> :
        page.kind === "area"       ? <AreaPageView page={page} /> :
        page.kind === "program"    ? <ProgramView page={page} /> :
        page.kind === "stop"       ? <StopView id={page.id} /> :
        page.kind === "bus"        ? <BusView id={page.id} /> :
        page.kind === "directions" ? <DirectionsView /> :
        page.kind === "new"        ? <NewEventView place={page.place} /> :
        page.kind === "you"        ? <YouView /> :
        page.kind === "buses"      ? <BusesView /> :
                                     <EventView id={page.id} />}
      {r(() => notice.value && <p class="notice" role="status">{notice.value}</p>)}
    </section>
  )
}
