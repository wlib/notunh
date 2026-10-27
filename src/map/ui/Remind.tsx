/** @jsxImportSource bruh/browser */

// "Remind me" for the chosen itinerary, whatever its shape, or for walking the whole way (src/reminders/), or for a
// visit (src/shared/visit.mts) from any occurrence's page, an event's, a class's or a place's, with nothing saved or
// marked going: a class's goes on to its next meetings (src/reminders/queue.mts). Offered where the Worker has
// reminders set up, and on iOS once notunh is on the Home Screen, and not for a trip to leave for within the
// heads-up, whose card's own "leave in" is the reminder. And the reminders kept on this phone, rows of Yours on the
// home, each opening its trip again as its notification's tap does, or cancelled there

import { type SourceNode, r } from "bruh/reactive"
import type { Itinerary } from "../../routing/plan.mts"
import { HEADS_UP, HEADS_UPS, type Kept, type Reminder, isCurrent, isTooSoon, reminderOf, unplanned } from "../../reminders/reminder.mts"
import { type Resolver, queueOf } from "../../reminders/queue.mts"
import { OFFSETS, type Visit, isSameOccasion, thereBy } from "../../shared/visit.mts"
import { randomBase64Url } from "../../shared/base64url.mts"
import { cancel, kept, loadKept, prepare, ready, remind, support, topUp } from "../state/reminders.mts"
import { ClockTime, Minutes, minutesText } from "../../shell/intl.tsx"
import { capture } from "../../shell/usage.tsx"
import { Icon } from "../../shell/ui.tsx"
import { Time } from "./common.tsx"
import { Row } from "./Pages.tsx"
import { state } from "../state/map.mts"

const isSupported = support()

/** Brings a reminder's trip back, as a notification's tap does: from where you are if it was, by its time, its way chosen */
export const open = async (reminder: Kept) => {
  state.from.value = reminder.from.isYou ? undefined : reminder.from
  state.by.value = reminder.by
  await state.directTo(reminder.to)
  state.selected.value = reminder.way
}

/** The reminders kept here whose trips are still to come, soonest first */
export const currentReminders = r(() => [...kept.value.values()].filter(reminder => isCurrent(reminder, state.now.value)).sort((a, b) => a.start - b.start))

/** The reminders kept here, as rows of Yours: each a tap from its trip, in directions, or from being cancelled */
export const Reminders = () =>
  r(() => currentReminders.value.map(reminder =>
    <Row
      time={<>leave <Time seconds={reminder.start} /></>}
      what={reminder.visit?.occurrence?.title ?? reminder.to.name}
      sub={<><Icon name="bell" /> Reminder{reminder.by !== undefined && <> · there by <Time seconds={reminder.by} /></>}{reminder.state === "setting" && " · set once online"}</>}
      onclick={() => {
        void open(reminder)
        state.go({ kind: "directions" })
        capture("reminder_opened")
      }}
      aside={
        <button type="button" class="clear" aria-label={`Cancel reminder for ${reminder.to.name}`} onclick={() => void cancel(reminder.id)}>
          <Icon name="close" />
        </button>
      }
    />
  ))

/** Where a visit is on the map, for a class's queue to keep, as the service worker can't look it up */
const locate = (visit: Visit) =>
  state.placeOfVisit(visit)

/**
 * Tops up every class reminder's queue from the courses as they are now, which a page showing sections calls as it
 * opens, with the courses' resolver: the section's meetings still to come, soonest first, to its last
 */
export const topUpClasses = (resolve: Resolver) =>
  topUp(resolve, locate)

/** When to be there for a visit: at its start, or some minutes before, a choice that belongs to the visit, which Directions and Remind share */
export const ArrivalOffset = ({ offset, at }: { offset: SourceNode<number>, at: number }) =>
  <div class="offsets" role="group" aria-label="Be there">
    {OFFSETS.map(ms =>
      <button type="button" class="chip" aria-pressed={r(() => offset.value === ms ? "true" : "false")} onclick={() => offset.value = ms}>
        {ms ? <><Minutes value={ms / 60_000} /> before</> : <>At <ClockTime at={new Date(at)} /></>}
      </button>
    )}
  </div>

/**
 * Remind for a visit: its arrival offset, unless the page shows one for Directions too and shares it here, and for
 * a class, its section's id and the courses' resolver, which make it go on to the next meetings
 */
type VisitProps = { visit: Visit, offset?: SourceNode<number>, section?: { id: string, resolve: Resolver } }

/** The reminder a visit sets, as of now: by the best way from where you are, or till that's known, to be there by its time */
const reminderFor = (visit: Visit, headsUp: number): Reminder | undefined => {
  const to = locate(visit)
  const way = to && state.wayToVisit(visit)
  if (way)
    return reminderOf(state.feed.peek(), way, "", state.now.peek(), { headsUp, by: thereBy(visit) / 1000, visit })
  return to && unplanned("", { ...to, name: "Your location", isYou: true }, { visit, to }, 0, headsUp)
}

export const Remind = (props: { itinerary: Itinerary } | VisitProps) => {
  if (isSupported === "none")
    return null
  if (isSupported === "install")
    return <p class="remind muted">Add notunh to your Home Screen for reminders.</p>

  // Readied once an itinerary is chosen or a visit shown, so a map only looked at never asks the Worker
  void prepare()
  void loadKept()
  const headsUp = r(HEADS_UP)
  const problem = r<string | undefined>()
  const isSetting = r(false)
  const offset = "visit" in props ? props.offset ?? r(props.visit.offset) : undefined
  const visit = r(() => "visit" in props ? { ...props.visit, offset: offset!.value } : undefined)
  const planned = r(() =>
    "itinerary" in props
      ? reminderOf(state.feed.value, props.itinerary, "", state.now.peek(), { headsUp: headsUp.value, by: state.by.value })
      : reminderFor(visit.value!, headsUp.value)
  )
  const section = "section" in props ? props.section : undefined
  const set = r(() => [...kept.value.values()].find(reminder =>
    reminder.state !== "cancelling" && (
      section       ? reminder.queue?.section === section.id :
      visit.value   ? reminder.visit !== undefined && isSameOccasion(reminder.visit, visit.value) :
                      reminder.way === planned.value?.way
    )
  ))
  const tooSoon = r(() => !planned.value || isTooSoon(planned.value, state.now.value))

  const select: HTMLSelectElement =
    <select aria-label="Heads-up before leaving" onchange={() => headsUp.value = Number(select.value)}>
      {/* An option holds only text, never an element, so its minutes are formatted here */}
      {HEADS_UPS.map(seconds => <option value={String(seconds)} selected={seconds === HEADS_UP}>{minutesText(seconds / 60)} heads-up</option>)}
    </select>

  const onclick = () => {
    const at = ready.peek()
    if (!at)
      return
    isSetting.value = true
    problem.value = undefined
    const reminder = { ...planned.peek()!, id: randomBase64Url(16) }
    const queue = section && queueOf(reminder, section.id, section.resolve(section.id) ?? [], locate, state.now.peek())
    // Straight from the tap, so iOS asks for permission
    remind(at, reminder, queue).then(
      () => capture("reminder_set"),
      error => {
        console.warn(error)
        // Subscribing is refused this way when notifications are off for the site
        problem.value = error instanceof DOMException && error.name === "NotAllowedError"
          ? "Notifications are off for notunh in your settings."
          : "The reminder couldn't be set. Try again in a moment."
      }
    ).finally(() => isSetting.value = false)
  }

  return (
    <div class="remind">
      {r(() => {
        const reminder = set.value
        if (reminder)
          return (
            <p class="reminder-set">
              <Icon name="bell" /> <strong>{reminder.state === "set" ? "Reminder set" : "Reminder saved, set once online"}</strong> · leave <Time seconds={reminder.start} />{" · "}
              <button type="button" class="link" onclick={() => void cancel(reminder.id)}>Cancel</button>
            </p>
          )
        if (!ready.value || tooSoon.value)
          return null
        return (
          <>
            <button type="button" class="button" disabled={isSetting} onclick={onclick}><Icon name="bell" /> Remind me</button>
            {select}
          </>
        )
      })}
      {"visit" in props && !props.offset && <ArrivalOffset offset={offset!} at={props.visit.arriveBy} />}
      {r(() => problem.value && <p class="muted">{problem.value}</p>)}
    </div>
  )
}
