/** @jsxImportSource bruh/browser */

// The campus as a directory with a pulse: the home's Campus view (Home.tsx), one row for each thing the app does, in
// the same order every visit, each saying what's so of it now in place of a description: the meal on and till when, the
// washers free in your hall, the buses live, the next club meeting, your next class, where you can park. Each row opens
// a page in the sheet. Dining's is the two halls side by side, which is the choice there is to make, and laundry's
// every hall with yours first, both marked on the map while they're shown (render/status.mts); classes' is your week
// and the ways into the courses. A hall's place then leads with its meal, and a residence hall's with its machines
// (PlaceGlance), and those link on to the pages of their own, /dining/ and /laundry/, for the week's menus and each
// machine. Dining is the one thing Today shows too, near its top while a hall is serving or about to, and the search
// for food, each hall's row there going straight to its menu (DiningSoon, DiningResults)

import { type DerivativeNode, r } from "bruh/reactive"
import type { BruhChild } from "bruh/browser"
import { type Status, wallDate } from "../../dining/hours.mts"
import { highlights } from "../../dining/menus.mts"
import type { Counts, RoomSummary } from "../../laundry/infer.mts"
import { KINDS } from "../../laundry/infer.mts"
import { pathOf, roomAtSlug } from "../../laundry/rooms.mts"
import { courseOf } from "../../courses/course.mts"
import { options } from "../../parking/model.mts"
import { localDay } from "../../shared/time.mts"
import { ClockTime, Count, Counted, Day, Minutes } from "../../shell/intl.tsx"
import { distinct } from "../../shell/state.mts"
import { Icon } from "../../shell/ui.tsx"
import type { Page } from "../link.mts"
import type { HallNow, Laundry } from "../state/campus.mts"
import { defaultStay } from "../state/parking.mts"
import { state } from "../state/map.mts"
import { nextDate } from "./Ahead.tsx"
import { Status as BusStatus } from "./Buses.tsx"
import { minutes, nowMs, walkTo } from "./common.tsx"
import { Group, MyCourses } from "./Courses.tsx"
import { DayName, Head, LinkLine, placeNamed } from "./Pages.tsx"
import { SportsFact } from "./Sports.tsx"

const capitalized = (word: string) =>
  word[0].toUpperCase() + word.slice(1)

//#region Dining now

const Clock = ({ at }: { at: { day: string, minute: number } }) =>
  <ClockTime at={wallDate(at)} timeZone="UTC" />

/** When a closed hall opens, its day too where that isn't today */
const Opens = ({ at }: { at: { day: string, minute: number } }) =>
  <>{at.day !== localDay(nowMs()) && <><Day of={at.day} weekday="short" /> </>}<Clock at={at} /></>

/** A hall's standing, lit while it's open: "Open till 9:00 PM", "Opens 7:15 AM", "Closed" */
const Standing = ({ standing }: { standing?: Status }) =>
  !standing       ? null :
  standing.isOpen ? <span class="live"><span class="dot" />Open till <Clock at={standing.closes} /></span> :
  standing.opens  ? <>Opens <Opens at={standing.opens} /></> :
                    <>Closed</>

/** A hall's first word, as people say it: "Holloway", "Philbrook" */
const shortName = (name: string) =>
  name.split(" ")[0]

/**
 * The halls in a few words, as the index says them: the meal being served, and till when the halls are open, said as
 * the halls' hours and not the meal's, as the menus name each day's meals without their times; or when the first opens
 */
const DiningFact = () =>
  r(() => {
    const halls = state.hallsNow.value
    const { open, next } = state.dining.value
    if (open.length) {
      const meal = open[0].meal?.meal
      const closes = open.map(({ standing }) => wallDate(standing.closes).getTime())
      const isTogether = open.length === halls.length && closes.every(at => at === closes[0])
      return <>
        <span class="dot" />{meal && <>{capitalized(meal)} · </>}
        {isTogether ? halls.length === 2 ? "both halls" : "halls" : open.map(hall => shortName(hall.name)).join(" & ")}
        {" open till "}<ClockTime at={new Date(Math.min(...closes))} timeZone="UTC" />
      </>
    }
    return next ? <>Closed · {shortName(next.hall.name)} opens <Opens at={next.opens} /></> : halls.length ? "Closed" : "Menus and hall hours"
  })

/**
 * A hall as a row: its standing, the walk there, and what the meal leads with, which opens its place on the map, or
 * its menu where the row is the quick way there, as on the home and in the search
 */
const HallRow = ({ hall, toMenu = false }: { hall: HallNow, toMenu?: boolean }) => {
  const walk = walkTo(placeNamed(hall.name))
  const dishes = hall.meal ? highlights(hall.meal, 4) : []
  const what =
    <span class="row-what">
      <strong class="truncate">{hall.name}</strong>
      <span class="hall-standing"><Standing standing={hall.standing} />{walk !== undefined && <span class="muted"> · <Minutes value={minutes(walk)} /> walk</span>}</span>
      {dishes.length > 0 && <span class="muted hall-dishes"><span class="hall-meal">{capitalized(hall.meal!.meal)}</span> {dishes.map(({ food }) => food).join(", ")}</span>}
    </span>
  return (
    <li>
      {toMenu
        ? <a class="row hall-row" href={`/dining/?hall=${hall.id}`}>{what}<span class="row-state" aria-hidden="true">›</span></a>
        : <button type="button" class="row hall-row" onclick={() => state.go({ kind: "place", name: hall.name })}>{what}<span class="row-state" aria-hidden="true">›</span></button>}
    </li>
  )
}

/**
 * Dining in Today, near its top, while a hall is serving or about to: each such hall's row, which opens its menu.
 * Otherwise it steps aside, as Campus says when the next opens
 */
export const DiningSoon = ({ halls }: { halls: HallNow[] }) =>
  <>
    <h2 class="eyebrow">Dining</h2>
    <ul class="rows halls" aria-label="Dining">{halls.map(hall => <HallRow hall={hall} toMenu />)}</ul>
  </>

// What searching for food means, a word typed being the start of one of them: "menu" as much as "menus"
const FOOD_WORDS = ["dining", "menus", "food", "eating", "meals", "breakfast", "brunch", "lunch", "dinner"]

/** The halls for a search that means food, each row its menu, open or not */
export const DiningResults = ({ query }: { query: DerivativeNode<string> }) =>
  r(() => {
    const words = query.value.trim().toLocaleLowerCase().split(/\s+/)
    const isFood = words.some(word => word.length >= 3 && FOOD_WORDS.some(food => food.startsWith(word)))
    const halls = state.hallsNow.value
    return isFood && halls.length > 0 && <Group label="Dining">{halls.map(hall => <HallRow hall={hall} toMenu />)}</Group>
  })

/** Dining in the sheet: the two halls beside each other, as the choice between them is the one there is to make */
export const DiningView = () => {
  state.wantMeals()
  state.focusAt({ kind: "dining" }, undefined)
  return <>
    <Head kind="Campus" title="Dining" />
    <ul class="rows halls">{r(() => state.hallsNow.value.map(hall => <HallRow hall={hall} />))}</ul>
    <div class="lines">
      <LinkLine href="/dining/">The week's menus, diets and allergens</LinkLine>
    </div>
    <p class="view-foot muted">Menus from UNH Dining. Hours vary on breaks.</p>
  </>
}

/** A dining hall's place, leading with what it's serving: the meal, a few dishes by station, and its menu in full */
const HallGlance = ({ hall }: { hall: HallNow }) => {
  const dishes = hall.meal ? highlights(hall.meal, 6) : []
  return (
    <section class="glance">
      <h3 class="eyebrow">{hall.meal ? `${capitalized(hall.meal.meal)} today` : "Today"}</h3>
      {dishes.length > 0
        ? <ul class="dishes">
            {dishes.map(({ food, station }) => <li><span class="truncate">{food}</span><span class="muted truncate">{station}</span></li>)}
          </ul>
        : <p class="muted">No menu posted for today.</p>}
      <div class="lines">
        <LinkLine href={`/dining/?hall=${hall.id}`}>{hall.meal ? <>All of {hall.meal.meal}, and the week</> : "The week's menus"}</LinkLine>
      </div>
    </section>
  )
}

//#endregion

//#region Laundry now

/** A kind's machines as pips, the free ones lit, so a room reads at a glance */
const Pips = ({ counts }: { counts: Counts }) =>
  <span class="pips" aria-hidden="true">
    {Array.from({ length: counts.total }, (_, i) => <span class={i < counts.free ? "pip free" : "pip"} />)}
  </span>

/** "3 of 4", the free count lit while there's one */
const Free = ({ counts }: { counts: Counts | undefined }) =>
  counts
    ? <span class="count"><strong class={{ live: counts.free > 0 }}><Count value={counts.free} /></strong><span class="muted"> of <Count value={counts.total} /></span></span>
    : <span class="count muted">—</span>

/** The laundry in a few words, as the index says it: your hall's machines free, else how many halls have a washer */
const LaundryFact = () =>
  r(() => {
    const counts = state.laundryCounts.value.value?.rooms
    if (!counts)
      return state.laundryCounts.value.isFailing ? "Washers and dryers by hall" : "Checking the machines…"
    const mine = state.laundry.value.find(({ room }) => state.starredRooms.value.has(room.id) && counts[room.id])
    if (mine) {
      const { washer, dryer } = counts[mine.room.id]
      return <><span class="dot" />{mine.room.name} · <Counted value={washer.free} one="washer" other="washers" />, <Counted value={dryer.free} one="dryer" other="dryers" /> free</>
    }
    const rooms = Object.values(counts)
    return <><span class="dot" />A washer free in <Count value={rooms.filter(room => room.washer.free > 0).length} /> of <Counted value={rooms.length} one="hall" other="halls" /></>
  })

/** The star that makes a room yours, as the laundry page's does */
const RoomStar = ({ id, name }: { id: string, name: string }) =>
  <button
    type="button"
    class="star"
    aria-label={`${name} is my hall`}
    aria-pressed={r(() => String(state.starredRooms.value.has(id)))}
    onclick={() => state.toggleStarred(id)}
  >
    <Icon name="star" />
  </button>

/** A room as laundry's row: its washers and dryers free in columns, which opens its building's place, else its own page */
const RoomRow = ({ room, building }: Laundry) => {
  const summary = r(() => state.countsOf(room.id))
  const cells = r(() => KINDS.map(kind => <Free counts={summary.value?.[kind]} />))
  return (
    <li class={r(() => state.starredRooms.value.has(room.id) ? "yours" : undefined)}>
      {building
        ? <button type="button" class="row room-row" onclick={() => state.go({ kind: "place", name: building.name })}><strong class="truncate">{room.name}</strong>{cells}</button>
        : <a class="row room-row" href={pathOf(room.id)}><strong class="truncate">{room.name}</strong>{cells}</a>}
      <RoomStar {...room} />
    </li>
  )
}

/** Laundry in the sheet: every hall's washers and dryers free, yours first, each marked on the map */
export const LaundryView = () => {
  state.wantCounts()
  state.focusAt({ kind: "laundry" }, undefined)
  return <>
    <Head kind="Campus" title="Laundry" />
    <p class="view-facts">
      {r(() => {
        const { value, isFailing } = state.laundryCounts.value
        const rooms = Object.values(value?.rooms ?? {})
        const free = (kind: "washer" | "dryer") => rooms.reduce((sum, room) => sum + room[kind].free, 0)
        return (
          value     ? <><span class="live"><span class="dot" /><Counted value={free("washer")} one="washer" other="washers" /> and <Counted value={free("dryer")} one="dryer" other="dryers" /> free</span> · as of <ClockTime at={new Date(value.at)} /></> :
          isFailing ? "The counts couldn't be checked. The rooms are listed all the same." :
                      "Checking the machines…"
        )
      })}
    </p>
    <ul class="rows rooms">
      <li class="rooms-head eyebrow" aria-hidden="true"><span>Hall</span><span>Washers</span><span>Dryers</span></li>
      {r(() => state.laundry.value.map(laundry => <RoomRow {...laundry} />))}
    </ul>
    <div class="lines">
      <LinkLine href="/laundry/">Each machine, time left and busy hours</LinkLine>
    </div>
    <p class="view-foot muted">Star your hall to keep it first, here and in Campus.</p>
  </>
}

/** A residence hall's place, leading with its machines: each room's washers and dryers free, and the room in full */
const RoomGlance = ({ slug, isNamed }: { slug: string, isNamed: boolean }) => {
  const room = roomAtSlug(slug)
  if (!room)
    return null
  const Kind = ({ label, counts }: { label: string, counts: Counts | undefined }) =>
    <div class="line machines">
      <span>{label}</span>
      {counts && <Pips counts={counts} />}
      <span class="line-value">{counts ? <span><Free counts={counts} /> free</span> : <span class="muted">Checking…</span>}</span>
    </div>
  return (
    <section class="glance">
      <header class="glance-head">
        <h3 class="eyebrow">Laundry{isNamed && ` · ${room.name}`}</h3>
        <RoomStar {...room} />
      </header>
      {r(() => {
        const summary: RoomSummary | undefined = state.countsOf(room.id)
        return <div class="lines">
          <Kind label="Washers" counts={summary?.washer} />
          <Kind label="Dryers" counts={summary?.dryer} />
          <LinkLine href={pathOf(room.id)}>Each machine and its time left</LinkLine>
        </div>
      })}
    </section>
  )
}

//#endregion

/** What a place's page leads with where it's a dining hall or has laundry rooms: the meal, or the machines */
export const PlaceGlance = ({ name }: { name: string }) => {
  const building = state.buildings.peek().find(building => building.name === name)
  if (!building)
    return null
  if (building.kind === "dining") {
    state.wantMeals()
    return r(() => {
      const hall = state.hallsNow.value.find(hall => hall.name === name)
      return hall && <HallGlance hall={hall} />
    })
  }
  state.wantCounts()
  return <>{building.rooms?.map(slug => <RoomGlance slug={slug} isNamed={building.rooms!.length > 1} />)}</>
}

/** Classes in the sheet: your week and saved sections, and the ways into the rest of the courses */
export const ClassesView = () => {
  state.focusAt({ kind: "classes" }, undefined)
  return <>
    <Head kind="Campus" title="Classes" />
    <p class="view-facts">Search a course, an instructor or a room from the map, and save a section from its page.</p>
    <MyCourses />
    <div class="lines">
      <LinkLine to={{ kind: "program" }}>Programs and what each requires</LinkLine>
      <LinkLine to={{ kind: "ahead" }}>Registration windows and deadlines</LinkLine>
      <LinkLine to={{ kind: "you" }}>Import your schedule from a calendar</LinkLine>
    </div>
  </>
}

//#region The index

/** A row of the index: its mark, its name, and what's so of it now, which opens its page */
const IndexRow = ({ icon, name, to, children }: { icon: string, name: string, to: Page, children?: BruhChild }) =>
  <li>
    <button type="button" class="row index-row" onclick={() => state.go(to)}>
      <span class="mark"><Icon name={icon} /></span>
      <span class="row-what">
        <strong>{name}</strong>
        <span class="muted truncate">{children}</span>
      </span>
      <span class="row-state" aria-hidden="true">›</span>
    </button>
  </li>

/** What meets today among the clubs and activities, and the next of them */
const ClubsFact = () =>
  r(() => {
    const now = nowMs()
    const today = localDay(now)
    const meeting = state.listings.value
      .flatMap(listing => listing.sessions.filter(session => session.end > now && localDay(session.start) === today).slice(0, 1).map(session => ({ listing, session })))
      .sort((a, b) => a.session.start - b.session.start)
    const next = meeting.find(({ session }) => session.start > now) ?? meeting[0]
    return next
      ? <><Count value={meeting.length} /> meet today · {next.session.start > now ? "next" : "now"} {next.listing.name}{next.session.start > now && <> <ClockTime at={new Date(next.session.start)} /></>}</>
      : <><Counted value={state.listings.value.filter(listing => listing.sessions.length).length} one="activity" other="activities" /> meeting this term</>
  })

/** What's still on today, and the next of it */
const WeekFact = () =>
  r(() => {
    const now = nowMs()
    const left = state.todayList.value.filter(event => event.end > now && !state.activityOf(event))
    const next = left.find(event => event.start > now)
    return left.length
      ? <><Counted value={left.length} one="event" other="events" /> left today{next && <> · next <ClockTime at={new Date(next.start)} /></>}</>
      : "Nothing more today · see the week"
  })

/** Your next class, where you've saved any */
const ClassesFact = () =>
  r(() => {
    const [next] = state.classes.value
    return next
      ? <>{next.event.start > nowMs() ? "Next" : "Now"} {courseOf(next.section)} · {localDay(next.event.start) !== localDay(nowMs()) && <><DayName day={localDay(next.event.start)} /> </>}<ClockTime at={new Date(next.event.start)} /> · {next.event.where}</>
      : "Your week, programs and rooms"
  })

/**
 * Where you can park now for a couple of hours, as the parking page would rank it with nothing asked: how many areas
 * fit your permit, or with none, how many are free and how many paid. Made again once a minute, not each second
 */
const ParkingFact = () => {
  const minute = distinct(() => Math.floor(nowMs() / 60_000))
  return r(() => {
    const { areas } = state.parking.value
    if (!areas.length)
      return "Where you can park, by permit"
    const permit = state.permit.value
    const fitting = options(areas, { permit, purpose: "visit" }, defaultStay(minute.value * 60_000), state.holidays.value).filter(({ fits }) => fits === "yes")
    const free = fitting.filter(({ cost }) => cost === 0).length
    return permit
      ? <><span class="dot" /><Counted value={fitting.length} one="area fits" other="areas fit" /> your permit now</>
      : free
        ? <><span class="dot" /><Count value={free} /> free now · <Count value={fitting.length - free} /> paid · no permit</>
        : <><Count value={fitting.length} /> paid now · no permit</>
  })
}

/** The next date on the academic calendar */
const TermFact = () =>
  r(() => {
    const date = nextDate()
    return date ? <>{date.title} · <Day of={date.day} month="short" day="numeric" /></> : "Deadlines, registration and breaks"
  })

/** The campus by what it does, in one order, each row saying what's so of it now */
export const CampusIndex = () => {
  state.wantMeals()
  state.wantCounts()
  return (
    <ul class="rows index" aria-label="Campus">
      <IndexRow icon="dining" name="Dining" to={{ kind: "dining" }}><DiningFact /></IndexRow>
      <IndexRow icon="laundry" name="Laundry" to={{ kind: "laundry" }}><LaundryFact /></IndexRow>
      <IndexRow icon="bus" name="Buses" to={{ kind: "buses" }}><BusStatus /></IndexRow>
      <IndexRow icon="people" name="Clubs & activities" to={{ kind: "explore" }}><ClubsFact /></IndexRow>
      <IndexRow icon="calendar" name="Events this week" to={{ kind: "week" }}><WeekFact /></IndexRow>
      <IndexRow icon="trophy" name="Sports" to={{ kind: "sports" }}><SportsFact /></IndexRow>
      <IndexRow icon="classes" name="Classes" to={{ kind: "classes" }}><ClassesFact /></IndexRow>
      <IndexRow icon="parking" name="Parking" to={{ kind: "parking" }}><ParkingFact /></IndexRow>
      <IndexRow icon="flag" name="Term dates" to={{ kind: "ahead" }}><TermFact /></IndexRow>
    </ul>
  )
}

//#endregion
