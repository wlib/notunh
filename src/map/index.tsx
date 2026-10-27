/** @jsxImportSource bruh/browser */

import "../shell/index.mts"
import "./index.css"

import { r, watch } from "bruh/reactive"
import { createMap } from "./render/map.mts"
import { startMap } from "./state/map.mts"
import { AppTitle } from "../shell/ui.tsx"
import { Home } from "./ui/Home.tsx"
import { open as openReminder, topUpClasses } from "./ui/Remind.tsx"
import { PageView } from "./ui/Pages.tsx"
import { Status } from "./ui/Buses.tsx"
import { isAsked } from "./ui/You.tsx"
import { RideSuggestion } from "./ui/BusView.tsx"
import { makeSheet, raise } from "./ui/sheet.mts"
import { capture } from "../shell/usage.tsx"
import { distinct } from "../shell/state.mts"
import { isSameView } from "./state/page.mts"
import { nameAt } from "../places/gazetteer.mts"
import { coarseName } from "../places/coarse.mts"
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
    {r(() => shownPage.value && <PageView page={shownPage.value} />)}
  </aside>

const mapElement = <div class="map" /> as HTMLElement
const panel = <Panel /> as HTMLElement
document.getElementById("app")!.replaceChildren(mapElement, panel)

makeSheet(panel, grabber, header)
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

createMap(
  mapElement,
  panel,
  state,
  tap => {
    // A place tapped opens its page, as its marker, its outline and a search for it all do; a stop or a bus its own
    if (tap.kind === "place") {
      const shown = page.peek()
      if (shown?.kind !== "place" || shown.name !== tap.name)
        state.go({ kind: "place", name: tap.name })
      capture("place_opened")
    }
    else if (tap.kind === "stop")
      state.go({ kind: "stop", id: feed.peek().stops[tap.stop].id })
    else if (tap.kind === "bus")
      state.go({ kind: "bus", id: tap.id })
    else {
      // A spot tapped is where the trip's going, or where it's from while that's yet to be said in directions, named
      // for what the map shows there once that's known
      const end = page.peek()?.kind === "directions" && to.peek() && !from.peek() ? from : to
      end.value = tap.place
      nameAt(state.gazetteer.peek(), tap.place, tap.hints).then(name => {
        if (name && end.peek() === tap.place)
          end.value = { ...tap.place, name }
      }, () => {})
      if (page.peek()?.kind !== "directions")
        state.go({ kind: "directions" })
    }
  }
)
