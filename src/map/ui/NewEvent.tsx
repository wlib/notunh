/** @jsxImportSource bruh/browser */

// Making an event of your own, a page entered from a place, with Where filled, or from the home: what, where, a
// place the map knows, searched as you type, and where exactly in it, a day with a start and an end, up to two more
// times for people to mark (src/social/marks.mts), details, how many spots, and whether everyone on campus can find
// it, which takes a verified UNH email. Posted, it's kept by the Worker and opens as its page

import { r } from "bruh/reactive"
import { MAX_SPOTS, MAX_TIMES, SHORT, LONG, type Time as Window, placeNames } from "../../social/event.mts"
import * as api from "../../social/browser/api.mts"
import { randomBase64Url } from "../../shared/base64url.mts"
import { HOUR, atClock, hhmm, localDay } from "../../shared/time.mts"
import { capture } from "../../shell/usage.tsx"
import { state } from "../state/map.mts"
import { Head } from "./Pages.tsx"
import { verified } from "./You.tsx"

/** How many of the places matching what's typed are offered */
const OFFERED = 6

/** A place the map knows, searched by name as it's typed, with the names matching offered under the field */
const Where = ({ chosen }: { chosen?: string }) => {
  const query = r(chosen ?? "")
  const picked = r(chosen)
  const isOpen = r(false)
  const input: HTMLInputElement =
    <input
      name="place"
      type="text"
      autocomplete="off"
      required
      placeholder="A building or a named spot"
      value={query.peek()}
      onfocus={() => isOpen.value = true}
      onblur={() => { isOpen.value = false; input.value = picked.peek() ?? "" }}
      // A name typed whole is picked as it would be from the list
      oninput={() => { query.value = input.value; picked.value = placeNames(state.gazetteer.peek()).find(name => name === input.value.trim()) }}
    />
  const matching = r(() => {
    const text = query.value.trim().toLocaleLowerCase()
    const names = placeNames(state.gazetteer.value)
    return (text ? names.filter(name => name.toLocaleLowerCase().includes(text)) : []).slice(0, OFFERED)
  })
  return (
    <label class="field">
      <span>Where</span>
      {input}
      {r(() => isOpen.value && !picked.value && matching.value.length > 0 &&
        <ul class="suggestions" role="listbox" aria-label="Places">
          {matching.value.map(name =>
            <li role="option" onpointerdown={event => event.preventDefault()} onclick={() => { picked.value = name; input.value = query.value = name; input.blur() }}>{name}</li>
          )}
        </ul>
      )}
    </label>
  )
}

/** A day, a start and an end, as native fields, read back as a window on Durham's clock */
const When = ({ hidden, start }: { hidden?: ReturnType<typeof r<boolean>>, start?: number }) =>
  <div class="field-row when-fields" hidden={hidden}>
    <label class="field"><span>Day</span><input name="day" type="date" value={start === undefined ? "" : localDay(start)} /></label>
    <label class="field"><span>Start</span><input name="start" type="time" value={start === undefined ? "" : hhmm(start)} /></label>
    <label class="field"><span>End</span><input name="end" type="time" value={start === undefined ? "" : hhmm(start + HOUR)} /></label>
  </div>

/** The windows the fields hold, each a day with a start and an end, an end before its start reading as the next day's */
const windowsOf = (data: FormData): Window[] => {
  const days = data.getAll("day").map(String)
  const starts = data.getAll("start").map(String)
  const ends = data.getAll("end").map(String)
  return days.flatMap((day, i) => {
    if (!/^\d{4}-\d\d-\d\d$/.test(day) || !/^\d\d:\d\d$/.test(starts[i]) || !/^\d\d:\d\d$/.test(ends[i]))
      return []
    const start = atClock(day, starts[i])
    const end = atClock(day, ends[i])
    return [{ start, end: end > start ? end : end + 24 * HOUR }]
  })
}

export const NewEventView = ({ place }: { place?: string }) => {
  const problem = r<string>()
  const isSending = r(false)
  /** Times beyond the first offered, for people to mark */
  const more = r(0)
  const start = Math.ceil(Date.now() / HOUR) * HOUR + HOUR
  const isPublic = r(false)

  const form: HTMLFormElement =
    <form class="new-event" onsubmit={event => {
      event.preventDefault()
      const data = new FormData(form)
      const times = windowsOf(data)
      const spots = Number(data.get("spots")) || undefined
      if (!times.length)
        return problem.value = "An event needs a day, a start and an end."
      isSending.value = true
      problem.value = undefined
      api.makePin({
        id:          randomBase64Url(16),
        title:       String(data.get("title")),
        description: String(data.get("description")),
        place:       String(data.get("place")),
        where:       String(data.get("where")),
        times,
        spots,
        visibility:  isPublic.peek() ? "public" : "link"
      }).then(
        pin => {
          capture("pin_made", { times: times.length, spots: spots !== undefined, public: pin.visibility === "public" })
          void state.refreshPins()
          state.go({ kind: "event", id: pin.id })
        },
        (error: Error) => {
          problem.value = error.message
          isSending.value = false
        }
      )
    }}>
      <Head title="New event" />
      <label class="field"><span>What</span><input name="title" type="text" required maxlength={SHORT} placeholder="Tennis, anyone?" /></label>
      <Where chosen={place} />
      <label class="field"><span>Where exactly</span><input name="where" type="text" maxlength={SHORT} placeholder="Court 5, room 164, behind the MUB" /></label>
      <When start={start} />
      {/* Kept in the form while hidden, so a time typed stays typed as another is added */}
      {Array.from({ length: MAX_TIMES - 1 }, (_, i) => <When hidden={r(() => more.value <= i)} />)}
      {r(() => more.value < MAX_TIMES - 1 && <button type="button" class="more" onclick={() => more.value++}>+ Another time</button>)}
      {r(() => more.value > 0 && <p class="muted">People mark the times that work, and you set one.</p>)}
      <label class="field"><span>Details</span><textarea name="description" rows={2} maxlength={LONG} placeholder="Any level. I have spare balls." /></label>
      <div class="field-row">
        <label class="field"><span>Spots</span><input name="spots" type="number" inputmode="numeric" min="1" max={String(MAX_SPOTS)} placeholder="No limit" /></label>
        <div class="field">
          <span>Who can find it</span>
          <div class="segmented" role="group" aria-label="Who can find it">
            <button type="button" aria-pressed={r(() => isPublic.value ? "false" : "true")} onclick={() => isPublic.value = false}>Link only</button>
            <button type="button" aria-pressed={r(() => isPublic.value ? "true" : "false")} disabled={r(() => !verified.value)} title={r(() => verified.value ? undefined : "Takes a verified UNH email, in You")} onclick={() => isPublic.value = true}>Everyone</button>
          </div>
        </div>
      </div>
      {r(() => problem.value && <p class="notice" role="alert">{problem.value}</p>)}
      <button type="submit" class="button primary" disabled={isSending}>Post it</button>
      {r(() => !verified.value && <p class="muted">Everyone on campus can find it once your UNH email is verified, in You.</p>)}
    </form>
  return form
}
