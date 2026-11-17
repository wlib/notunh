/** @jsxImportSource bruh/browser */

// Clubs and activities, around "Could I go?": the directory (src/social/series.mts), narrowed first by what meets
// today, what's a drop-in, a day and a time of day, then by interest. Each row says its next time and room and opens
// the activity's page, which says who runs it, how to join and its next sessions, and offers to follow it and to
// subscribe to every session. The same rows answer search and say what meets at a place. And the week, a day at a
// time, folded as the home folds today. A club's description and members are never read, so never shown

import { type DerivativeNode, r } from "bruh/reactive"
import { type Event, isOn, whereOf } from "../../social/event.mts"
import { INTERESTS, type Interest, type Join, type Listing } from "../../social/series.mts"
import { calendarPath } from "../../social/calendar.mts"
import { addDays, daysBetween, localDay, localMinutes, weekday } from "../../shared/time.mts"
import { ClockTime, Count, Counted, Day, Weekdays, relativeDay } from "../../shell/intl.tsx"
import { state } from "../state/map.mts"
import { nowMs } from "./common.tsx"
import { Group } from "./Courses.tsx"
import { DayName, EventLines, EventRow, Head, LinkLine, Row, focusOn } from "./Pages.tsx"

const JOIN: Record<Join, string> = { "drop-in": "Drop in", "sign-up": "Sign up", team: "Team practice", ask: "Ask the organizer" }

const NOT_POSTED = "No meeting posted"

/** What an activity's link is to, by who runs it */
const SOURCE_LINK: Record<Listing["kind"], string> = { club: "Wildcat Link page", rec: "Sign up on Campus Rec", practice: "Club Sports page", curated: "UNH's page" }

/** An activity as a row: its next session, or the one asked for, where it is and how to join, which opens its page */
export const ActivityRow = ({ listing, next = listing.sessions[0] }: { listing: Listing, next?: Event }) =>
  <Row
    class={r(() => state.isFollowing(listing.key) ? "yours" : undefined)}
    time={next ? <><DayName day={localDay(next.start)} /><small><ClockTime at={new Date(next.start)} /></small></> : <span class="muted">—</span>}
    what={listing.name}
    sub={next ? <>{next.where || whereOf(next)} · {next.left === 0 ? "Full" : JOIN[listing.join]}</> : NOT_POSTED}
    standing="›"
    onclick={() => state.go({ kind: "activity", id: listing.key })}
  />

/** Under an event's facts, the activity it's a session of, which its own page follows */
export const PartOf = ({ event }: { event: Event }) =>
  r(() => {
    const listing = state.activityOf(event)
    return listing && (
      <div class="lines part-of">
        <LinkLine to={{ kind: "activity", id: listing.key }}>
          {listing.name}<span class="muted"> · {listing.days.length ? <>every <Weekdays days={listing.days} style="narrow" /></> : "activity"}{r(() => state.isFollowing(listing.key) && " · following")}</span>
        </LinkLine>
      </div>
    )
  })

export const ActivityView = ({ id }: { id: string }) =>
  r(() => {
    const listing = state.listingOf(id)
    if (!listing)
      return <><Head title="No such activity" /><p class="muted">It may have stopped meeting.</p></>
    const next = listing.sessions[0]
    focusOn({ kind: "activity", id }, next?.place ?? listing.place, next?.start)
    const following = r(() => state.isFollowing(listing.key))
    return <>
      <Head kind={<>{listing.host} · {listing.interest}</>} title={listing.name} />
      <p class="view-facts">
        {listing.days.length
          ? <><strong>Every <Weekdays days={listing.days} /></strong>{listing.times === 1 ? <> · <ClockTime at={new Date(next!.start)} /></> : <> · <Count value={listing.times} /> times</>}{listing.where && ` · ${listing.where}`}</>
          : listing.meets ? <>{listing.meets}{listing.where && ` · ${listing.where}`}</> : NOT_POSTED}
      </p>
      <p class="view-facts join"><strong>How to join</strong> · {JOIN[listing.join]}</p>
      <div class="view-actions">
        <button type="button" class="button primary" aria-pressed={r(() => String(following.value))} onclick={() => state.setFollowed(listing.key, !following.peek())}>
          {r(() => following.value ? `Following ${listing.name}` : `Follow ${listing.name}`)}
        </button>
        <a class="button" href={listing.url} target="_blank" rel="noopener">{SOURCE_LINK[listing.kind]}</a>
      </div>
      {r(() => following.value && <p class="view-facts muted">Its next session stays in Yours.</p>)}
      {listing.sessions.length > 0 && <>
        <h3 class="eyebrow">Next sessions</h3>
        <ul class="rows">{listing.sessions.slice(0, 5).map(event => <EventRow event={event} day="" />)}</ul>
        <div class="lines">
          <div class="line">
            <span>Calendar</span>
            <span class="line-value"><a class="go" href={`webcal://${location.host}${calendarPath("activity", listing.key)}`}>Subscribe to all <Counted value={listing.sessions.length} one="session" other="sessions" /> ›</a></span>
          </div>
        </div>
      </>}
    </>
  })

/** What meets at a place every week, each once */
export const SeriesHere = ({ name }: { name: string }) =>
  r(() => {
    const here = state.listings.value.filter(listing => listing.place === name && listing.sessions.length)
    return here.length > 0 && <>
      <h3 class="eyebrow">Every week here</h3>
      <ul class="rows">{here.map(listing => <ActivityRow listing={listing} />)}</ul>
    </>
  })

/** How many activities search lists */
const FOUND = 5

/** Search's clubs and activities: those whose name has every word typed, each once, those meeting first */
export const SeriesResults = ({ query }: { query: DerivativeNode<string> }) =>
  r(() => {
    const words = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(word => word.length > 1)
    if (!words.length)
      return null
    const found = state.listings.value
      .filter(({ name }) => words.every(word => name.toLocaleLowerCase().includes(word)))
      .sort((a, b) => +!a.sessions.length - +!b.sessions.length)
      .slice(0, FOUND)
    return found.length > 0 && <Group label="Clubs & activities">{found.map(listing => <ActivityRow listing={listing} />)}</Group>
  })

/** The home's ways into its lists, under the search, so they're there with the sheet half up */
export const Shortcuts = () =>
  <nav class="chips shortcuts" aria-label="Browse">
    <button type="button" class="chip" onclick={() => state.go({ kind: "explore" })}>Clubs &amp; activities ›</button>
    <button type="button" class="chip" onclick={() => state.go({ kind: "week" })}>This week ›</button>
    <button type="button" class="chip" onclick={() => state.go({ kind: "ahead" })}>Plan ahead ›</button>
  </nav>

/** Parts of a day, by the minute after midnight they start at, for "Could I go this evening?" */
const PARTS = { morning: [0, 12 * 60], afternoon: [12 * 60, 17 * 60], evening: [17 * 60, 24 * 60] } as const
type Part = keyof typeof PARTS

type Filters = { today: boolean, dropIn: boolean, day?: number, part?: Part, interest?: Interest }

/** An activity's first session to come as asked: on the day and in the part of it asked for, or none */
const sessionAs = (listing: Listing, { today, dropIn, day, part }: Filters, now: number) =>
  !dropIn || listing.join === "drop-in" ? listing.sessions.find(({ start, end }) => {
    const minute = localMinutes(start)
    const date = localDay(start)
    return end > now && (!today || date === localDay(now)) &&
      (day === undefined || weekday(date) === day) &&
      (!part || minute >= PARTS[part][0] && minute < PARTS[part][1])
  }) : undefined

/** The filters chosen, kept for the visit so Back finds them as left */
const filters = r<Filters>({ today: false, dropIn: false })

/** A chip that's a filter, pressed while it's on */
const FilterChip = ({ label, isOn, toggle }: { label: string, isOn: () => boolean, toggle: () => void }) =>
  <button type="button" class="chip" aria-pressed={r(() => isOn() ? "true" : "false")} onclick={toggle}>{label}</button>

export const ExploreView = () => {
  state.focusAt({ kind: "explore" }, undefined)
  const set = (change: Partial<Filters>) => filters.value = { ...filters.peek(), ...change }
  const day: HTMLSelectElement =
    <select aria-label="Day" onchange={() => set({ day: day.value === "" ? undefined : +day.value })}>
      <option value="">Any day</option>
      {["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"].map((label, weekday) => <option value={String(weekday)} selected={filters.peek().day === weekday}>{label}</option>)}
    </select>
  const part: HTMLSelectElement =
    <select aria-label="Time of day" onchange={() => set({ part: (part.value || undefined) as Part | undefined })}>
      <option value="">Any time</option>
      {(Object.keys(PARTS) as Part[]).map(name => <option value={name} selected={filters.peek().part === name}>{name[0].toUpperCase() + name.slice(1)}</option>)}
    </select>
  return (
    <>
      <Head title="Clubs & activities" />
      <div class="chips filters" role="group" aria-label="Could I go?">
        <FilterChip label="Meets today" isOn={() => filters.value.today} toggle={() => set({ today: !filters.peek().today })} />
        <FilterChip label="Drop-in" isOn={() => filters.value.dropIn} toggle={() => set({ dropIn: !filters.peek().dropIn })} />
        {day}
        {part}
      </div>
      {r(() => {
        const now = nowMs()
        const chosen = filters.value
        const listings = state.listings.value
        const asked = new Map(listings.flatMap(listing => {
          const session = sessionAs(listing, chosen, now)
          return session ? [[listing.key, session] as const] : []
        }))
        const isNarrowed = chosen.today || chosen.dropIn || chosen.day !== undefined || chosen.part !== undefined
        const interests = INTERESTS.filter(interest => listings.some(listing => listing.interest === interest))
        const matching = listings.filter(listing => asked.has(listing.key) && (!chosen.interest || listing.interest === chosen.interest))
        const unposted = isNarrowed ? [] : listings.filter(listing => !listing.sessions.length && (!chosen.interest || listing.interest === chosen.interest))
        const followed = matching.filter(listing => state.isFollowing(listing.key))
        const shown = matching.filter(listing => !state.isFollowing(listing.key))
        return <>
          <div class="chips interests" role="group" aria-label="Interests">
            <FilterChip label="All" isOn={() => !filters.value.interest} toggle={() => set({ interest: undefined })} />
            {interests.map(interest =>
              <FilterChip label={interest} isOn={() => filters.value.interest === interest} toggle={() => set({ interest: filters.peek().interest === interest ? undefined : interest })} />
            )}
          </div>
          <p class="view-facts muted"><Counted value={matching.length} one="activity" other="activities" />{unposted.length > 0 && <> · <Count value={unposted.length} /> more clubs haven't posted a meeting</>}</p>
          {followed.length > 0 && <>
            <h2 class="eyebrow">Following</h2>
            <ul class="rows">{followed.map(listing => <ActivityRow listing={listing} next={asked.get(listing.key)} />)}</ul>
          </>}
          {isNarrowed
            // Narrowed, soonest first, as "what could I go to" asks
            ? <ul class="rows">{shown.toSorted((a, b) => asked.get(a.key)!.start - asked.get(b.key)!.start).map(listing => <ActivityRow listing={listing} next={asked.get(listing.key)} />)}</ul>
            : interests.filter(interest => !chosen.interest || interest === chosen.interest).map(interest => {
              const here = shown.filter(listing => listing.interest === interest)
              const quiet = unposted.filter(listing => listing.interest === interest)
              return (here.length > 0 || quiet.length > 0) && <>
                <h2 class="eyebrow">{interest}</h2>
                <ul class="rows">{here.map(listing => <ActivityRow listing={listing} />)}</ul>
                {quiet.length > 0 && <details class="view-group">
                  <summary><span class="muted"><Counted value={quiet.length} one="club hasn't" other="clubs haven't" /> posted a meeting</span><span class="row-state" aria-hidden="true">›</span></summary>
                  <ul class="rows">{quiet.map(listing => <ActivityRow listing={listing} />)}</ul>
                </details>}
              </>
            })}
          <p class="view-foot muted">From Wildcat Link's clubs, Campus Rec, UNH Club Sports and UNH's own pages.</p>
        </>
      })}
    </>
  )
}

/** The day the week shows, kept for the visit so Back finds it as left */
const shownDay = r<string>()

/** The week a day at a time, "What's on Thursday?", each day folded as the home folds today */
export const WeekView = () => {
  state.focusAt({ kind: "week" }, undefined)
  return r(() => {
    const now = nowMs()
    const today = localDay(now)
    const days = Array.from({ length: 7 }, (_, i) => addDays(today, i))
    const day = shownDay.value && days.includes(shownDay.value) ? shownDay.value : today
    const away = daysBetween(today, day)
    const events = [...state.events.value.events, ...state.pins.value].filter(event => event.end > now && isOn(event, day, now)).sort((a, b) => a.start - b.start)
    return <>
      <Head kind="This week" title={away < 2 ? `What's on ${relativeDay(away).toLowerCase()}?` : `What's on ${new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`))}?`} name="This week" />
      <div class="chips days week-days" role="group" aria-label="Day">
        {days.map(shown => <button type="button" class="chip" aria-pressed={shown === day ? "true" : "false"} onclick={() => shownDay.value = shown}><DayName day={shown} /></button>)}
      </div>
      {events.length
        ? <ul class="rows" aria-label={day}><EventLines events={events} day={day} /></ul>
        : <p class="muted">Nothing listed <Day of={day} weekday="long" />.</p>}
    </>
  })
}
