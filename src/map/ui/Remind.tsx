/** @jsxImportSource bruh/browser */

// "Remind me when to leave" for an itinerary's first bus (src/reminders/). Offered where the Worker has reminders set
// up, and on iOS once notunh is on the Home Screen

import { r } from "bruh/reactive"
import { routeLabel } from "../../transit/feed.mts"
import type { Itinerary, RideLeg } from "../../routing/plan.mts"
import { type Reminder, leadTime, watchOf } from "../../reminders/reminder.mts"
import { randomId } from "../../reminders/store.mts"
import { cancel, kept, loadKept, prepare, ready, remind, support } from "../../reminders/client.mts"
import { Minutes } from "../../shell/intl.tsx"
import { capture } from "../../shell/usage.tsx"
import { Time, minutes, route } from "./common.tsx"
import { state } from "../state/map.mts"

/** Leads to choose from, in minutes before the bus, besides the one worked out */
const CHOICES = [5, 10, 15, 20, 30]

const isSupported = support()

/** The reminder an itinerary would set: its first bus, the walk to its stop, and where it goes */
const reminderOf = (itinerary: Itinerary, ride: RideLeg, override: number | undefined): Reminder => {
  const { run, fromPosition, start } = ride
  const feed = state.feed.peek()
  const [first] = itinerary.legs
  const walk = first.kind === "walk" ? first.end - first.start : 0
  const last = itinerary.legs.at(-1)!
  const stop = feed.stops[run.trip.stops[fromPosition]]
  return {
    id:        randomId(),
    trip:      run.trip.id,
    route:     run.trip.route,
    stop:      stop.id,
    routeName: routeLabel(route(run.trip.route)),
    stopName:  stop.name,
    scheduled: run.base + run.trip.times[fromPosition],
    expected:  start,
    walk,
    lead:      leadTime({ walk, isLive: run.isLive, override }),
    to:        last.kind === "walk" ? last.to.name : feed.stops[last.run.trip.stops[last.toPosition]].name,
    arrival:   itinerary.end
  }
}

export const Remind = ({ itinerary }: { itinerary: Itinerary }) => {
  const ride = itinerary.legs.find(leg => leg.kind === "ride")
  if (!ride || isSupported === "none")
    return null
  if (isSupported === "install")
    return <p class="remind muted">Add notunh to your Home Screen to get a reminder when to leave.</p>

  // Readied once an itinerary is chosen, so a map only looked at never asks the Worker
  void prepare()
  void loadKept()
  const trip = ride.run.trip.id
  const stopId = state.feed.peek().stops[ride.run.trip.stops[ride.fromPosition]].id
  const override = r<number | undefined>(undefined)
  const problem = r<string | undefined>()
  const isSetting = r(false)
  const scheduled = ride.run.base + ride.run.trip.times[ride.fromPosition]
  const set = r(() => [...kept.value.values()].find(reminder => reminder.trip === trip && reminder.stop === stopId && reminder.scheduled === scheduled))

  const select: HTMLSelectElement =
    <select aria-label="When to remind you" onchange={() => override.value = select.value ? Number(select.value) * 60 : undefined}>
      <option value="">{r(() => <>About <Minutes value={minutes(reminderOf(itinerary, ride, undefined).lead)} /> before the bus</>)}</option>
      {CHOICES.map(choice => <option value={String(choice)}><Minutes value={choice} /> before the bus</option>)}
    </select>

  const onclick = () => {
    const at = ready.peek()
    if (!at)
      return
    const reminder = reminderOf(itinerary, ride, override.peek())
    isSetting.value = true
    problem.value = undefined
    // Straight from the tap, so iOS asks for permission
    remind(at, reminder, watchOf(reminder)).then(
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
            <p>
              Reminder set: you'll be told about <Minutes value={minutes(reminder.lead)} /> before the <Time seconds={reminder.expected} /> bus at {reminder.stopName}.{" "}
              <button type="button" class="button" onclick={() => void cancel(reminder.id)}>Cancel reminder</button>
            </p>
          )
        if (!ready.value)
          return null
        return (
          <>
            <button type="button" class="button" disabled={isSetting} onclick={onclick}>Remind me when to leave</button>
            {select}
          </>
        )
      })}
      {r(() => problem.value && <p class="muted">{problem.value}</p>)}
    </div>
  )
}
