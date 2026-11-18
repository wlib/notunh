/** @jsxImportSource bruh/browser */

// The courses beside the map's own: search's labelled groups of instructors, sections and rooms under the places
// (Search.tsx), the instructor's row already answering with their next scheduled class, its room, and Directions;
// and My courses, in You, the sections saved as a week, with what's in the calendars imported here beside them
// (Calendars.tsx) and your finals in theirs, your finals listed where this device is told them (state/finals.mts),
// your feed of them for a calendar app, and a pasted schedule saved in one go (src/courses/saved.mts). Your next
// saved class is a row of Yours on the home (Home.tsx)

import { type DerivativeNode, r } from "bruh/reactive"
import type { BruhChild } from "bruh/browser"
import type { Page } from "../link.mts"
import { codeOf, courseOf } from "../../courses/course.mts"
import { isClassAt } from "../../courses/imported.mts"
import type { Courses } from "../../courses/browser/terms.mts"
import { type Person, nextTeaching } from "../../courses/people.mts"
import { crnsIn } from "../../courses/search.mts"
import { spaceFor } from "../../courses/spaces.mts"
import { weekOf } from "../../courses/saved.mts"
import { visitOf } from "../../shared/visit.mts"
import { addDays, localDay, weekday } from "../../shared/time.mts"
import { ClockTime, Count, Counted, Day } from "../../shell/intl.tsx"
import { Icon } from "../../shell/ui.tsx"
import { today as currentDay } from "../../shell/lifecycle.mts"
import { state } from "../state/map.mts"
import { Feed } from "./Calendars.tsx"
import { nowMs } from "./common.tsx"
import { DayName, FinalRow, Row, SectionRow, directions, roomOf, sectionPage } from "./Pages.tsx"

/** Done with search once a result's tapped: the field let go of, which puts the rest of the panel back */
const blur = () =>
  (document.activeElement as HTMLElement | null)?.blur()

/**
 * A group of search's results, labelled, kept from taking focus from the field so a tap doesn't end the search first:
 * on mousedown, as WebKit sends no click for a touch whose pointerdown is called off
 */
export const Group = ({ label, children }: { label: string, children?: BruhChild }) =>
  <section class="found" aria-label={label} onmousedown={(event: MouseEvent) => event.preventDefault()} onclick={blur}>
    <h3 class="eyebrow">{label}</h3>
    <ul class="rows">{children}</ul>
  </section>

/** An instructor's row, which already answers: their next scheduled class, when, where, and Directions to it */
const PersonRow = ({ courses, person }: { courses: Courses, person: Person }) => {
  const { next } = nextTeaching(person, courses.calendar, nowMs())
  return (
    <li class="answer">
      <button type="button" class="row" onclick={() => state.go({ kind: "person", id: person.id })}>
        <span class="row-what">
          <strong class="truncate">{person.name}</strong>
          <span class="muted">
            {next
              ? <>Next class <strong>{localDay(next.start) === localDay(nowMs()) ? "" : <><DayName day={localDay(next.start)} /> </>}<ClockTime at={new Date(next.start)} /> · {next.where}</strong> · {courseOf(next.section)}</>
              : "No more classes scheduled this term"}
          </span>
        </span>
      </button>
      {next?.place &&
        <button type="button" class="chip go" onclick={() => directions(visitOf(next), person.name)}>Directions ›</button>}
    </li>
  )
}

/** A room's row: what's scheduled there now, else next today, never that it's free */
const RoomRow = ({ courses, where }: { courses: Courses, where: string }) => {
  const at = nowMs()
  const today = courses.schedule.on({ room: where }, localDay(at))
  const under = today.find(({ event }) => event.start <= at && at < event.end)
  const next = today.find(({ event }) => event.start > at)
  return (
    <Row
      time={under ? "Now" : next ? <ClockTime at={new Date(next.event.start)} /> : ""}
      what={where}
      sub={<>
        {under && <>Now {courseOf(under.section)}</>}
        {under && next && " · then "}
        {next && <>{under ? "" : "Next "}{courseOf(next.section)} at <ClockTime at={new Date(next.event.start)} /></>}
        {!under && !next && "Nothing more scheduled today"}
      </>}
      standing="›"
      onclick={() => state.go({ kind: "room", where })}
    />
  )
}

/** Search's answers from the courses for what's typed: instructors, sections and rooms, each a labelled group */
export const CourseResults = ({ query }: { query: DerivativeNode<string> }) =>
  r(() => {
    const text = query.value.trim()
    const courses = state.courses.value
    if (!text || !courses)
      return null
    const { people, sections, rooms } = courses.search(text)
    // A room 25Live books is among the rooms to book, which say whether it's free (Rooms.tsx)
    const classrooms = rooms.filter(({ where }) => !spaceFor(state.spaces.value, where))
    return (
      <>
        {people.length > 0 && <Group label="Instructors">{people.map(person => <PersonRow courses={courses} person={person} />)}</Group>}
        {sections.length > 0 && <Group label="Sections">{sections.map(({ term, section }) => <SectionRow term={term} section={section} />)}</Group>}
        {classrooms.length > 0 && <Group label="Rooms">{classrooms.map(({ where }) => <RoomRow courses={courses} where={where} />)}</Group>}
      </>
    )
  })

/**
 * Your week, Monday first, the coming week's from the weekend: the saved sections' classes and finals and what's in
 * the calendars imported here, an imported class that's saved too told once, a day with nothing kept only on weekdays
 */
const Week = ({ courses }: { courses: Courses }) =>
  r(() => {
    // By the day alone, as a week of every calendar imported is read to show it
    const now = currentDay.value
    const from = weekday(now) >= 5 ? addDays(now, 7 - weekday(now)) : now
    const classes = weekOf(state.saved.value, courses.calendar, from)
    const imports = state.importsOn(classes[0].day, 7)
    const week = classes
      .map(({ day, classes }) => ({
        day,
        classes,
        finals:  state.yourFinals.value.filter(({ final }) => final.day === day),
        imports: imports.filter(one => localDay(one.start) === day && !classes.some(({ event, section }) => isClassAt(one, section, event.start)))
      }))
      .filter(({ classes, finals, imports }, i) => i < 5 || classes.length || finals.length || imports.length)
    return (
      <div class="week" style={`--days: ${week.length}`} aria-label="Your week">
        {week.map(({ day, classes, finals, imports }) =>
          <div class={{ "week-day": true, today: day === now }}>
            <span class="week-name"><Day of={day} weekday="short" /></span>
            {[
              ...classes.map(({ event, term, section }) => ({ start: event.start, what: courseOf(section), where: roomOf(event.where), to: sectionPage(term, section) as Page | undefined })),
              ...finals.map(({ event, term, section, final }) => ({ start: event.start, what: `${courseOf(section)} final`, where: final.rooms.length > 1 ? "Common" : roomOf(event.where), to: sectionPage(term, section), isFinal: true })),
              ...imports.map(({ event, start, match: { found, place } }) => ({
                start,
                what:  found ? courseOf(found.section) : event.title,
                where: event.where ? roomOf(event.where) : place ?? "",
                to:    found ? sectionPage(found.term, found.section) : place ? { kind: "place" as const, name: place } : undefined
              }))
            ].sort((a, b) => a.start - b.start).map(({ start, what, where, to, isFinal = false }: { start: number, what: string, where: string, to?: Page, isFinal?: boolean }) => {
              const said = <>
                <span><ClockTime at={new Date(start)} /></span>
                <strong>{what}</strong>
                <span class="muted truncate">{where}</span>
              </>
              return to
                ? <button type="button" class={{ "week-class": true, final: isFinal }} onclick={() => state.go(to)}>{said}</button>
                : <div class="week-class">{said}</div>
            })}
          </div>
        )}
      </div>
    )
  })

/** A schedule pasted from Banner or WebCat, its CRNs that the live terms know saved */
const Paste = ({ courses }: { courses: Courses }) => {
  /** How many sections the last paste saved, once there's been one */
  const standing = r<number>()
  const text: HTMLTextAreaElement = <textarea rows={2} aria-label="Your schedule, pasted" placeholder="Paste your schedule, or CRNs" />
  const add = () => {
    const found = crnsIn(text.value, courses.terms)
    for (const section of found)
      state.save(section)
    standing.value = found.length
    if (found.length)
      text.value = ""
  }
  return (
    <div class="paste">
      <div class="field-row">
        {text}
        <button type="button" class="button" onclick={add}>Save</button>
      </div>
      {r(() => standing.value !== undefined && <p class="muted" role="status">{standing.value ? <>Saved <Counted value={standing.value} one="section" other="sections" />.</> : "No CRNs notunh knows in that."}</p>)}
    </div>
  )
}

/** Your saved sections' finals, soonest first, where this device is told them, till the last is over */
const Finals = () =>
  r(() => {
    const finals = state.yourFinals.value.filter(({ event }) => event.end > nowMs())
    return finals.length > 0 && <>
      <h4 class="eyebrow">Finals</h4>
      <ul class="rows" aria-label="Your finals">{finals.map(yours => <FinalRow yours={yours} />)}</ul>
    </>
  })

/** My courses, a section of You: the week, the sections saved, their finals, your feed of them, and a pasted schedule */
export const MyCourses = () => {
  state.wantCourses()
  return (
    <section class="you-section">
      <h3 class="eyebrow">{r(() => state.saved.value.length ? <>My courses · <Count value={state.saved.value.length} /></> : "My courses")}</h3>
      {r(() => {
        const courses = state.courses.value
        if (!courses)
          return <p class="muted">{state.coursesFailed.value ? "The courses couldn't load." : "Loading courses…"}</p>
        return <>
          {(state.saved.value.length > 0 || state.calendars.value.length > 0) && <Week courses={courses} />}
          {state.saved.value.length > 0
            ? <>
                <ul class="rows" aria-label="Saved sections">
                  {state.saved.value.map(found =>
                    <SectionRow {...found} aside={
                      <button type="button" class="clear" aria-label={`Forget ${codeOf(found.section)}`} onclick={() => state.unsave(found)}>
                        <Icon name="close" />
                      </button>
                    } />
                  )}
                </ul>
                <Finals />
                <Feed />
              </>
            : <p class="muted">Save a section from its page, or paste your schedule.</p>}
          <Paste courses={courses} />
        </>
      })}
    </section>
  )
}
