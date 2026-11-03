/** @jsxImportSource bruh/browser */

import "../shell/index.mts"
import "./index.css"

import { r, untrack, watch } from "bruh/reactive"
import { createMap } from "./render/map.mts"
import { startMap } from "./state/map.mts"
import { AppTitle } from "../shell/ui.tsx"
import { Home } from "./ui/Home.tsx"
import { open as openReminder, topUpClasses } from "./ui/Remind.tsx"
import { PageView, placeNamed } from "./ui/Pages.tsx"
import { Status } from "./ui/Buses.tsx"
import { isAsked } from "./ui/You.tsx"
import { RideSuggestion } from "./ui/BusView.tsx"
import { editing } from "./ui/Search.tsx"
import { makeSheet, raise } from "./ui/sheet.mts"
import { capture } from "../shell/usage.tsx"
import { distinct } from "../shell/state.mts"
import { isSameView } from "./link.mts"
import { nameAt } from "../places/gazetteer.mts"
import { coarseName } from "../places/coarse.mts"
import type { Place } from "../places/search.mts"
import { localDay, localHour, weekday } from "../shared/time.mts"
import { type Kept, type Reminder, firstRide, replanned } from "../reminders/reminder.mts"
import { kept, loadKept, replan } from "./state/reminders.mts"

const state = await startMap()
const { from, to, itineraries, itinerary, buildings, feed, suggested, locationProblem, plansFor, walkingTo, located, heard, page, backTo } = state

// A trip kept from earlier today, or one a link plans, opens on its directions; a link asking you to approve or
// confirm something opens You (ui/You.tsx)
if (!page.peek() && isAsked)
  state.amend({ kind: "you" })
else if (!page.peek() && to.peek())
  state.amend({ kind: "directions" })

const grabber = <button type="button" class="grabber" /> as HTMLElement

/** The page shown, the same one while parking's fields change what it's asked for, so they keep their focus */
const shownPage = distinct(() => page.value, isSameView)
const isPage = r(() => shownPage.value !== undefined)

// The map's title and how live the buses are, which opens them, or with a page shown, Back to what it was opened
// from, which the sheet lowered still shows
const header =
  <header class="panel-header">
    <span class="panel-title" hidden={isPage}>
      <AppTitle page="Map" />
      <button type="button" class="status-button" onclick={() => state.go({ kind: "buses" })}><Status /> ›</button>
    </span>
    <button type="button" class="back" hidden={r(() => !isPage.value)} aria-label={r(() => `Back to ${backTo.value}`)} onclick={() => state.back()}>
      <span aria-hidden="true">‹</span> {backTo}
    </button>
  </header> as HTMLElement

// The home stays put beneath a page, hidden, so the search and the week are as they were once Back returns to them
const Panel = () =>
  <aside class="panel">
    {grabber}
    {header}
    <RideSuggestion />
    <div hidden={isPage}><Home /></div>
    {/* Only another page replaces the one shown: what a view reads as it's made, like the clock, is its own to follow */}
    {r(() => {
      const page = shownPage.value
      return page && untrack(() => <PageView page={page} />)
    })}
  </aside>

const mapElement = <div class="map" /> as HTMLElement
const panel = <Panel /> as HTMLElement
document.getElementById("app")!.replaceChildren(mapElement, panel)

const sheet = makeSheet(panel, grabber, header)
// How far down the page shown is, for the history to keep as another opens over it
panel.addEventListener("scroll", () => state.scrolled.value = sheet.scrolled(), { passive: true })
// A page opened starts at its top, and one returned to is where it was left, once the views swapped in have rendered
watch([state.scrollTo], () => queueMicrotask(() => sheet.scrollTo(state.scrollTo.peek().top)))
// Something new to show brings the sheet back up
watch([from, to, page], raise, { skipFirst: true })
// And so does a question or a problem for you
watch(() => {
  if (suggested.value || locationProblem.value)
    raise()
})

// A trip planned is counted once both its ends are chosen, but not again as one from or to you moves with you, nor
// for one kept from earlier. Its ends are counted as coarse places, and it's sent unlinked (src/shell/events.mts)
const ends = distinct(() => from.value && to.value && `${from.value.name}\n${to.value.name}`)
let planned = ends.peek()
watch([ends], () => {
  if (ends.value && ends.value !== planned) {
    const named = [...buildings.peek(), ...feed.peek().stops]
    const at = Date.now()
    const [fromName, toName] = [from.peek()!, to.peek()!].map(end => coarseName(end, named, feed.peek().stops))
    // A task later, once the itineraries, which follow the ends a microtask late as this does, are the trip's
    setTimeout(() => capture("trip_planned", {
      from:         fromName,
      to:           toName,
      hour_of_week: weekday(localDay(at)) * 24 + localHour(at),
      itineraries:  itineraries.peek().length,
      rides_bus:    itinerary.peek()?.legs.some(leg => leg.kind === "ride") ?? false,
      walk_only:    !itineraries.peek().length
    }))
  }
  planned = ends.value
})

// A reminder's trip, planned again now: from where you are, where it was from there, its way if that's still
// offered, else the best way now, or walking so as to be there by its time; a visit's, the best way by bus or on
// foot (src/shared/visit.mts). One walked for now stays as it was
const plannedAgain = (reminder: Kept): Reminder | undefined => {
  const here = from.peek()?.isYou ? from.peek() : undefined
  const start = reminder.from.isYou ? here : reminder.from
  if (!start || (!firstRide(reminder) && reminder.by === undefined))
    return
  const options =
    reminder.visit && reminder.by !== undefined ? state.waysBy(start, reminder.to, reminder.by) :
    firstRide(reminder)                         ? plansFor(start, reminder.to, reminder.by) :
                                                  [walkingTo(start, reminder.to, reminder.by)]
  return replanned(feed.peek(), reminder, options, state.now.peek())
}

/** ms to wait for where you are and for live data before the reminders' trips are planned again, else not this time */
const REPLAN_WAIT_MS = 20_000

// A notification's tap opens /map/?reminder=<id>, which brings its trip back, from where you are if it was, and
// the link is then dropped from the URL as ?to= is. With any reminders kept still ahead, each is planned again as
// the map loads, once where you are and the live buses are known, so the plan is from where you are and as live
// as the one kept, and the Worker told where that moves its leave time or changes its first bus
const link = new URLSearchParams(globalThis.location.search).get("reminder")
if (link !== null)
  history.replaceState(history.state, "", globalThis.location.pathname)

// Class reminders go on to their sections' next meetings from the courses, which load for one kept, and are topped
// up from them as they load, so a room changed or a meeting dropped is what's queued (src/reminders/queue.mts)
watch([kept], () => {
  if ([...kept.value.values()].some(reminder => reminder.queue))
    state.wantCourses()
})
watch([state.courses, state.later], () => {
  if (state.courses.value)
    void topUpClasses(state.resolveClass)
})
void loadKept().then(async () => {
  const reminder = link === null ? undefined : kept.peek().get(link)
  if (reminder) {
    await openReminder(reminder)
    state.amend({ kind: "directions" })
  }
  if (!kept.peek().size)
    return
  const isReady = await Promise.race([Promise.all([located, heard]).then(() => true), new Promise<false>(resolve => setTimeout(resolve, REPLAN_WAIT_MS, false))])
  if (isReady)
    await replan(plannedAgain)
})

/** The planner's field being typed in as the map was touched, which a spot tapped then is for ("Search or tap the map") */
let picking: typeof editing.value
mapElement.addEventListener("pointerdown", () => picking = editing.peek(), { capture: true })
/** The spot a tap last dropped a pin at, as named once that's known, while it's where the trip goes */
let dropped: Place | undefined
/** Done with the field typed in, and its keyboard */
const doneTyping = () =>
  (document.activeElement as HTMLElement | null)?.blur()

createMap(
  mapElement,
  panel,
  state,
  tap => {
    const shown = page.peek()
    // In directions, the field being typed in as the map was touched, which whatever's tapped then is for
    const field = shown?.kind === "directions" && (picking === "from" || picking === "to") ? picking : undefined
    if (tap.kind === "place" && field) {
      const place = placeNamed(tap.name)
      const end = field === "from" ? from : to
      if (place)
        end.value = place
      doneTyping()
    }
    // A place tapped opens its page, as its marker, its outline and a search for it all do; a stop or a bus its own
    else if (tap.kind === "place") {
      if (shown?.kind !== "place" || shown.name !== tap.name)
        state.go({ kind: "place", name: tap.name })
      capture("place_opened")
    }
    else if (tap.kind === "stop")
      state.go({ kind: "stop", id: feed.peek().stops[tap.stop].id })
    else if (tap.kind === "bus")
      state.go({ kind: "bus", id: tap.id })
    else {
      // A spot tapped is one end of the trip only when asked for: the end whose field was being typed in, else a pin
      // dropped there, the trip's way there, from the home alone. Anywhere else it puts away what the map marks, the
      // page's place or the pin dropped, as tapping off something does, and leaves a page without one be
      if (!field && shown) {
        const isDropped = shown.kind === "directions" && dropped !== undefined && to.peek() === dropped
        if (isDropped) {
          to.value = dropped = undefined
          state.by.value = undefined
        }
        if (isDropped || state.focus.peek())
          state.back()
        return
      }
      const end = field === "from" ? from : to
      const place = tap.place
      end.value = place
      if (end === to)
        dropped = place
      doneTyping()
      nameAt(state.gazetteer.peek(), place, tap.hints).then(name => {
        if (name && end.peek() === place) {
          end.value = { ...place, name }
          if (dropped === place)
            dropped = end.peek()
        }
      }, () => {})
      if (shown?.kind !== "directions")
        state.go({ kind: "directions" })
    }
  }
)
