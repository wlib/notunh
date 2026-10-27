/** @jsxImportSource bruh/browser */

// An event's page at its link (p/index.html.tsx): the event as the Worker has it, for anyone with the link, with no
// account and no install, as a light page that opens in a story's browser. Its pieces are the map's event page's
// (ui.tsx): the times to pick while its time is unset, and once set, Going. Directions and Remind need the map's
// planner, so they're the event on the map

import "../shell/index.mts"
import "../shell/page.css"
import "./pin.css"

import { r } from "bruh/reactive"
import type { Pin } from "./event.mts"
import { urlOf } from "../map/link.mts"
import { isUnset } from "./marks.mts"
import { askOf } from "./ask.mts"
import * as api from "./browser/api.mts"
import { share } from "./story.mts"
import { type Act, Going, Moderate, SHARED, Times } from "./ui.tsx"
import { AppTitle } from "../shell/ui.tsx"
import { Counted, DayTimeRange } from "../shell/intl.tsx"

const id = decodeURIComponent(location.pathname.split("/")[2] ?? "")

/** Opened from an ask, tapped, which answers Going */
const isAnswering = location.hash === "#going"
if (isAnswering)
  history.replaceState(null, "", location.pathname + location.search)

const pin = r<Pin>()
const gone = r(false)
const notice = r<string>()

const act: Act = f => () => {
  notice.value = undefined
  f().then(result => result && (pin.value = result), (error: Error) => notice.value = error.message)
}

const Page = ({ pin }: { pin: Pin }) => {
  const unset = isUnset(pin)
  const isAsked = !unset && !pin.isGoing && pin.chosen !== undefined && (pin.marked?.includes(pin.chosen) ?? false)
  return <>
    <header class="pin-head">
      <AppTitle page="Event" />
      <h2 class="pin-title">{pin.title}</h2>
      <p class="pin-when">{unset ? "Time to pick" : <DayTimeRange from={new Date(pin.start)} to={new Date(pin.end)} />}</p>
      <p class="pin-where">
        <strong>{pin.place ?? pin.where}</strong>
        {pin.where && pin.where !== pin.place && <> · {pin.where}</>}
        {pin.spots !== undefined && <> · <Counted value={pin.spots} one="spot" other="spots" /></>}
      </p>
      {pin.description && <p class="pin-description">{pin.description}</p>}
    </header>

    {isAsked && <p class="ask" role="status">{askOf(pin).title}</p>}

    <div class="pin-actions">
      {!unset && <a class="button primary" href={urlOf({ kind: "event", id: pin.id })}>Directions</a>}
      {!unset && <Going pin={pin} act={act} />}
      <button type="button" class="button" onclick={() => share(pin, location.origin).then(how => notice.value = SHARED[how], (error: Error) => error.name === "AbortError" ? undefined : notice.value = error.message)}>
        Share
      </button>
    </div>

    {!unset && <p class="muted"><a href={urlOf({ kind: "event", id: pin.id })}>Remind me to leave</a></p>}
    {unset && <Times pin={pin} act={act} />}

    <p class="pin-foot muted">
      <Moderate pin={pin} act={act} onGone={() => gone.value = true} onReported={hidden => notice.value = hidden ? "Reported, and hidden." : "Reported."} />
      {" · "}<a href="/">notunh</a> is independent of UNH
    </p>
  </>
}

document.getElementById("app")!.replaceChildren(
  <div class="pin-body">
    {r(() =>
      gone.value   ? <p>This event is gone.</p> :
      pin.value    ? <Page pin={pin.value} /> :
      notice.value ? <p>{notice.value}</p> :
                     <p class="muted">Loading the event…</p>
    )}
    {r(() => pin.value && notice.value && <p class="notice" role="status">{notice.value}</p>)}
  </div> as HTMLElement
)

void api.preparePush()

api.pin(id).then(
  found => {
    if (!found)
      return notice.value = "No such event, or it's gone."
    pin.value = found
    // Tapping the ask was the answer, unless it's already given or there's no spot
    if (isAnswering && !isUnset(found) && !found.isGoing)
      act(() => api.setGoing(found.id, true))()
  },
  (error: Error) => notice.value = navigator.onLine ? error.message : "You're offline."
)
