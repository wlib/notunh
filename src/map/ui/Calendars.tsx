/** @jsxImportSource bruh/browser */

// Calendars, out and in. Out: a line on an event's, a series' and a section's page that adds it to a calendar app,
// as the file the Worker serves (worker/calendar.mts), which iOS offers to add and anything else downloads, or
// subscribed to by webcal, which follows a room change; and in You, your own feed of your saved sections and the
// events you're going to. In: My calendar, in You, a feed's address or a file from Canvas, Google or Outlook
// (state/calendars.mts), kept on this device, its events in your week beside your classes

import { r } from "bruh/reactive"
import { localDay } from "../../shared/time.mts"
import { Counted, Day } from "../../shell/intl.tsx"
import { today } from "../../shell/lifecycle.mts"
import { Icon } from "../../shell/ui.tsx"
import { capture } from "../../shell/usage.tsx"
import { state } from "../state/map.mts"

/** How many days of a calendar's events are matched to say how many classes were found in it */
const MATCHED_DAYS = 28

/** A calendar file's address as a subscription, which a calendar app reads again and again */
const webcal = (path: string) =>
  `webcal://${location.host}${path}`

/**
 * Whether this is an iOS Home Screen app, which has nowhere to show a calendar file and no Calendar to hand it to,
 * as Safari has; webcal is the system's, so there a file is added by subscribing to it
 */
const isHomeScreenApp = (navigator as { standalone?: boolean }).standalone === true

/**
 * A page's line that adds what it's of to a calendar app: once, as the file itself, which Safari on iOS offers to
 * add to Calendar and other browsers download for one; or for what goes on, as a subscription
 */
export const CalendarLine = ({ path, subscribe }: { path: string, subscribe?: string }) =>
  <div class="line">
    <span>Calendar</span>
    <span class="line-links">
      <a class="go" href={isHomeScreenApp ? webcal(path) : path} onclick={() => capture("calendar_added")}>Add ›</a>
      {subscribe && <a class="go" href={webcal(subscribe)} onclick={() => capture("calendar_subscribed")}>Subscribe ›</a>}
    </span>
  </div>

/** Your feed: subscribing to it, its address to paste where a calendar asks for one, and a new address, which ends the old */
export const Feed = () => {
  const standing = r<string>()
  const failed = () =>
    standing.value = "Couldn't make your link; try again online."
  const made = (then: (path: string) => unknown) => () => {
    standing.value = undefined
    const path = state.feedPath.peek()
    void (path ? Promise.resolve(path) : state.makeFeed()).then(then, failed)
  }
  const copy = (path: string) =>
    navigator.clipboard?.writeText(location.origin + path).then(() => standing.value = "Link copied.", () => {})
  return <>
    <div class="view-actions">
      {r(() => state.feedPath.value
        ? <a class="button" href={webcal(state.feedPath.value)} onclick={() => capture("calendar_subscribed")}>Subscribe</a>
        : <button type="button" class="button" onclick={made(path => location.assign(webcal(path)))}>Subscribe</button>)}
      <button type="button" class="button" onclick={made(copy)}>Copy link</button>
    </div>
    <p class="muted">
      Your classes and events in your calendar app, kept up to date. Anyone with the link can read them.
      {r(() => state.feedPath.value && <> <button type="button" class="go" onclick={() => void state.makeFeed().then(() => standing.value = "New link made; the old one no longer works.", failed)}>New link</button></>)}
    </p>
    {r(() => standing.value && <p class="notice" role="status">{standing.value}</p>)}
  </>
}

/** My calendar, a section of You: the calendars imported here, and adding one by its link or its file */
export const MyCalendar = () => {
  const standing = r<string>()
  const isAdding = r(false)
  const add = (from: { url: string } | { file: File }) => {
    if (isAdding.peek())
      return
    isAdding.value = true
    standing.value = undefined
    state.importCalendar(from).then(
      ({ events }) => {
        standing.value = events.length ? undefined : "Nothing in that calendar is at a time still to come."
        link.value = ""
        capture("calendar_imported")
      },
      (error: Error) => standing.value = error.message
    ).finally(() => isAdding.value = false)
  }
  const link: HTMLInputElement = <input type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck={false} placeholder="Calendar link" aria-label="Calendar link" />
  const file: HTMLInputElement = <input type="file" accept=".ics,text/calendar" hidden onchange={() => {
    if (file.files?.[0])
      add({ file: file.files[0] })
    file.value = ""
  }} />
  /** The coming weeks' imported events, each as matched, for how many classes were found in each calendar */
  const matched = r(() => state.importsOn(today.value, MATCHED_DAYS))
  void state.refreshCalendars()
  return (
    <section class="you-section">
      <h3 class="eyebrow">My calendar</h3>
      {r(() => state.calendars.value.length > 0 &&
        <ul class="rows" aria-label="Calendars">
          {state.calendars.value.map(({ id, name, at, events }) => {
            const classes = new Set(matched.value.flatMap(({ event, match }) => match.found && events.includes(event) ? [match.found.section] : []))
            return (
              <li class="calendar">
                <span class="row-what">
                  <strong class="truncate">{name}</strong>
                  <span class="muted truncate">
                    <Counted value={events.length} one="event" other="events" />
                    {classes.size > 0 && <> · <Counted value={classes.size} one="class" other="classes" /> found</>}
                    {" · read "}<Day of={localDay(at)} month="short" day="numeric" />
                  </span>
                </span>
                <button type="button" class="clear" aria-label={`Remove ${name}`} onclick={() => state.forgetCalendar(id)}>
                  <Icon name="close" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <p class="muted">Add yours from Canvas, Google or Outlook, by its link or an .ics file. It's kept on this device only.</p>
      <div class="field-row">
        {link}
        <button type="button" class="button" disabled={isAdding} onclick={() => link.value.trim() && add({ url: link.value })}>{r(() => isAdding.value ? "Adding…" : "Add")}</button>
      </div>
      {file}
      <button type="button" class="button" disabled={isAdding} onclick={() => file.click()}>Choose a file</button>
      {r(() => standing.value && <p class="notice" role="status">{standing.value}</p>)}
    </section>
  )
}
