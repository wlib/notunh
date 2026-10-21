/** @jsxImportSource bruh/browser */

// "Remind me" for the chosen itinerary, whatever its shape, or for walking the whole way (src/reminders/). Offered
// where the Worker has reminders set up, and on iOS once notunh is on the Home Screen, and not for a trip to leave
// for within the heads-up, whose card's own "leave in" is the reminder

import { r } from "bruh/reactive"
import type { Itinerary } from "../../routing/plan.mts"
import { HEADS_UP, HEADS_UPS, isTooSoon, reminderOf } from "../../reminders/reminder.mts"
import { randomBase64Url } from "../../shared/base64url.mts"
import { cancel, kept, loadKept, prepare, ready, remind, support } from "../state/reminders.mts"
import { capture } from "../../shell/usage.tsx"
import { Time } from "./common.tsx"
import { state } from "../state/map.mts"

const isSupported = support()

export const Remind = ({ itinerary }: { itinerary: Itinerary }) => {
  if (isSupported === "none")
    return null
  if (isSupported === "install")
    return <p class="remind muted">Add notunh to your Home Screen for reminders.</p>

  // Readied once an itinerary is chosen, so a map only looked at never asks the Worker
  void prepare()
  void loadKept()
  const headsUp = r(HEADS_UP)
  const problem = r<string | undefined>()
  const isSetting = r(false)
  const planned = r(() => reminderOf(state.feed.value, itinerary, "", state.now.peek(), { headsUp: headsUp.value, by: state.by.value }))
  const set = r(() => [...kept.value.values()].find(reminder => reminder.state !== "cancelling" && reminder.way === planned.value.way))
  const tooSoon = r(() => isTooSoon(planned.value, state.now.value))

  const select: HTMLSelectElement =
    <select aria-label="Heads-up before leaving" onchange={() => headsUp.value = Number(select.value)}>
      {HEADS_UPS.map(seconds => <option value={String(seconds)} selected={seconds === HEADS_UP}>{seconds / 60} min heads-up</option>)}
    </select>

  const onclick = () => {
    const at = ready.peek()
    if (!at)
      return
    isSetting.value = true
    problem.value = undefined
    // Straight from the tap, so iOS asks for permission
    remind(at, { ...planned.peek(), id: randomBase64Url(16) }).then(
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
              {reminder.state === "set" ? "Reminder set" : "Reminder saved, set once online"} · leave <Time seconds={reminder.start} />{" · "}
              <button type="button" class="link" onclick={() => void cancel(reminder.id)}>Cancel</button>
            </p>
          )
        if (!ready.value || tooSoon.value)
          return null
        return (
          <>
            <button type="button" class="button" disabled={isSetting} onclick={onclick}>Remind me</button>
            {select}
          </>
        )
      })}
      {r(() => problem.value && <p class="muted">{problem.value}</p>)}
    </div>
  )
}
