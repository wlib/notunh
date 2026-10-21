/** @jsxImportSource bruh/browser */

// "Remind me when to leave" for an itinerary's first bus (src/reminders/). Offered where the Worker has reminders set
// up, and on iOS once notunh is on the Home Screen

import { r } from "bruh/reactive"
import type { Itinerary } from "../../routing/plan.mts"
import { reminderOf } from "../../reminders/reminder.mts"
import { randomBase64Url } from "../../shared/base64url.mts"
import { cancel, kept, loadKept, prepare, ready, remind, support } from "../state/reminders.mts"
import { Minutes } from "../../shell/intl.tsx"
import { capture } from "../../shell/usage.tsx"
import { Time, minutes } from "./common.tsx"
import { state } from "../state/map.mts"

/** Leads to choose from, in minutes before the bus, besides the one worked out */
const CHOICES = [5, 10, 15, 20, 30]

const isSupported = support()

export const Remind = ({ itinerary }: { itinerary: Itinerary }) => {
  const planned = reminderOf(state.feed.peek(), itinerary, "")
  if (!planned || isSupported === "none")
    return null
  if (isSupported === "install")
    return <p class="remind muted">Add notunh to your Home Screen to get a reminder when to leave.</p>

  // Readied once an itinerary is chosen, so a map only looked at never asks the Worker
  void prepare()
  void loadKept()
  const override = r<number | undefined>(undefined)
  const problem = r<string | undefined>()
  const isSetting = r(false)
  const set = r(() => [...kept.value.values()].find(reminder =>
    reminder.state !== "cancelling" && reminder.trip === planned.trip && reminder.stop === planned.stop && reminder.scheduled === planned.scheduled
  ))

  const select: HTMLSelectElement =
    <select aria-label="When to remind you" onchange={() => override.value = select.value ? Number(select.value) * 60 : undefined}>
      <option value="">About <Minutes value={minutes(planned.lead)} /> before the bus</option>
      {CHOICES.map(choice => <option value={String(choice)}><Minutes value={choice} /> before the bus</option>)}
    </select>

  const onclick = () => {
    const at = ready.peek()
    if (!at)
      return
    isSetting.value = true
    problem.value = undefined
    // Straight from the tap, so iOS asks for permission
    remind(at, reminderOf(state.feed.peek(), itinerary, randomBase64Url(16), override.peek())!).then(
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
              {reminder.state === "set" ? "Reminder set" : "Reminder saved, and set once you're back online"}: you'll be told
              about <Minutes value={minutes(reminder.lead)} /> before the <Time seconds={reminder.expected} /> bus at {reminder.stopName}.{" "}
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
