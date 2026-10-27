/** @jsxImportSource bruh/browser */

// What an event made here shows wherever its page is, on the map (src/map/ui/Pages.tsx) and at its link (pin.tsx):
// Going, a count of the spots where there are some; the times to pick while its time is unset, each with one mark,
// "this time works for me", or for its host, Set; and its foot, where the host deletes it and anyone else reports it

import { type Pin } from "./event.mts"
import { goingWords, isFull } from "./marks.mts"
import * as api from "./browser/api.mts"
import { Count, DayTimeRange } from "../shell/intl.tsx"

/** Does something with the pin, for its page to show what comes back, or the Worker's refusal */
export type Act = (f: () => Promise<Pin | void>) => () => void

/** Going, as a count, of the spots where there are some, and Full once they're taken */
export const Going = ({ pin, act }: { pin: Pin, act: Act }) =>
  <button type="button" class="button" aria-pressed={pin.isGoing ? "true" : "false"} disabled={isFull(pin) && !pin.isGoing} onclick={act(() => api.setGoing(pin.id, !pin.isGoing))}>
    {goingWords(pin)}
  </button>

/** A time to pick: when, how many it works for, and this device's mark, or for the host, Set */
const TimeRow = ({ pin, i, act }: { pin: Pin, i: number, act: Act }) => {
  const isMarked = pin.marked?.includes(i) ?? false
  const { start, end } = pin.times[i]
  return (
    <li class="time">
      <span class="time-when"><DayTimeRange from={new Date(start)} to={new Date(end)} /></span>
      <span class="muted"><Count value={pin.marks[i]} /> can make it</span>
      {pin.yours
        ? <button type="button" class="button" onclick={act(() => api.setTime(pin.id, i))}>Set</button>
        : <button type="button" class="button mark" aria-pressed={isMarked ? "true" : "false"} onclick={act(() => api.mark(pin.id, i, !isMarked))}>
            {isMarked ? "Works for me" : "Mark"}
          </button>}
    </li>
  )
}

/** The times to pick from, while the event's time is unset: one mark each, or Set for the host */
export const Times = ({ pin, act }: { pin: Pin, act: Act }) =>
  <section class="times">
    <h3 class="eyebrow">{pin.yours ? "Set the time" : "Mark the times that work"}</h3>
    <ul>
      {pin.times.map((_, i) => <TimeRow pin={pin} i={i} act={act} />)}
    </ul>
    <p class="muted">{pin.yours ? "Whoever marked the time you set is asked if they're going." : "The host sets one. If you marked it, you'll be asked if you're going."}</p>
  </section>

/** Delete, for the host, or Report, for anyone else, as a quiet link in the page's foot */
export const Moderate = ({ pin, act, onGone, onReported }: { pin: Pin, act: Act, onGone: () => void, onReported: (hidden: boolean) => void }) =>
  pin.yours
    ? <button type="button" class="link" onclick={act(async () => { if (confirm("Delete this event?")) { await api.deletePin(pin.id); onGone() } })}>Delete this event</button>
    : <button type="button" class="link" onclick={act(async () => onReported((await api.report(pin.id)).hidden))}>Report</button>

/** What Share says it did: the story image is shared or saved, and the link copied for a Link sticker */
export const SHARED = { shared: "Link copied. In Instagram, add a Link sticker and paste.", downloaded: "Image saved and link copied. In Instagram, add a Link sticker and paste." }
