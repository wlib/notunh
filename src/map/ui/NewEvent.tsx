/** @jsxImportSource bruh/browser */

// Making an event of your own, a page entered from a place, with Where filled, or from the home: what, where, a
// place the map knows, searched as you type, and where exactly in it, a day with a start and an end, picked from chips
// over the native pickers, up to two more times for people to mark (src/social/marks.mts), details, how many spots,
// and whether everyone on campus can find it, which takes a verified UNH email. Posted, it's kept by the Worker and
// opens as its page. Editing one is the same form, filled with the event as it is, its times as its host sees them

import { r } from "bruh/reactive"
import { type Pin, MAX_SPOTS, MAX_TIMES, SHORT, LONG, type Time as Window, placeNames } from "../../social/event.mts"
import { isUnset } from "../../social/marks.mts"
import * as api from "../../social/browser/api.mts"
import { randomBase64Url } from "../../shared/base64url.mts"
import { HOUR, addDays, atClock, hhmm, localDay } from "../../shared/time.mts"
import { ClockTime } from "../../shell/intl.tsx"
import { capture } from "../../shell/usage.tsx"
import { state } from "../state/map.mts"
import { DayChips, Head, PickChip, keptPin } from "./Pages.tsx"
import { verified } from "./You.tsx"

/** How many of the places matching what's typed are offered */
const OFFERED = 6

/**
 * A place the map knows, searched as it's typed, by its name and by what people call it, with the places matching
 * offered under the field. One tapped is taken; so is the first offered once the field is left, by Enter or a tap
 * elsewhere, so "mub" is the Memorial Union Building, and nothing the map knows leaves the field empty
 */
const Where = ({ chosen }: { chosen?: string }) => {
  const query = r(chosen ?? "")
  const isOpen = r(false)
  // Of the places a pin can be at, as the map's search finds them
  const matching = r(() => {
    const names = new Set(placeNames(state.gazetteer.value))
    return state.searchPlaces.value(query.value).map(({ name }) => name).filter(name => names.has(name)).slice(0, OFFERED)
  })
  const input: HTMLInputElement =
    <input
      name="place"
      type="text"
      autocomplete="off"
      required
      placeholder="A building or a named spot"
      value={query.peek()}
      onfocus={() => isOpen.value = true}
      onblur={() => {
        isOpen.value = false
        input.value = query.value = matching.peek()[0] ?? ""
      }}
      oninput={() => query.value = input.value}
      onkeydown={event => {
        if (event.key === "Enter") {
          event.preventDefault()
          input.blur()
        }
      }}
    />
  return (
    <div class="field where">
      <label>
        <span>Where</span>
        {input}
      </label>
      {r(() => {
        if (!isOpen.value || !matching.value.length)
          return
        const list =
          <ul class="suggestions" role="listbox" aria-label="Places">
            {matching.value.map(name =>
              // Kept from taking focus from the field on mousedown, as WebKit sends no click for a touch whose pointerdown is called off
              <li role="option" onmousedown={event => event.preventDefault()} onclick={() => { query.value = name; input.blur() }}>{name}</li>
            )}
          </ul> as HTMLElement
        // Under a field low in the sheet, the list is past its edge until the sheet is scrolled to it
        requestAnimationFrame(() => list.scrollIntoView({ block: "nearest" }))
        return list
      })}
    </div>
  )
}

/**
 * A day, a start and an end, each a chip with its native picker over it: today, tomorrow or another day, and the times
 * on the clock as they read. Moving the start moves the end with it, keeping how long it is. Hidden, it's disabled, so
 * the form has none of it
 */
const When = ({ hidden, time, label = "When" }: { hidden?: ReturnType<typeof r<boolean>>, time: Window, label?: string }) => {
  const day = r(localDay(time.start))
  const from = r(hhmm(time.start))
  const to = r(hhmm(time.end))
  /** An "HH:MM" on the day picked, as a moment to show */
  const at = (clock: string) =>
    new Date(atClock(day.value, clock))
  const minutesOf = (clock: string) =>
    Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3))
  const clockAt = (minutes: number) =>
    `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
  return (
    <fieldset class="field when-fields" hidden={hidden} disabled={hidden}>
      <legend>{label}</legend>
      <DayChips day={day} name="day" />
      <div class="chips when-times">
        <PickChip type="time" name="start" label="Start" value={from} onpick={picked => {
          if (!picked)
            return
          const length = (minutesOf(to.peek()) - minutesOf(from.peek()) + 24 * 60) % (24 * 60)
          from.value = picked
          to.value = clockAt(minutesOf(picked) + length)
        }}>
          {r(() => <ClockTime at={at(from.value)} />)}
        </PickChip>
        <span aria-hidden="true">to</span>
        <PickChip type="time" name="end" label="End" value={to} onpick={picked => picked && (to.value = picked)}>
          {r(() => <ClockTime at={at(to.value)} />)}
        </PickChip>
      </div>
    </fieldset>
  )
}

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

/** A new event, at a place if one's given, or one of yours to edit, as the Worker has it */
export const NewEventView = ({ place, pin }: { place?: string, pin?: Pin }) => {
  const problem = r<string>()
  const isSending = r(false)
  const start = Math.ceil(Date.now() / HOUR) * HOUR + HOUR
  /** The times filled in: those to pick from while the time's to pick, else the one it's at, or the hour after next */
  const filled: Window[] = !pin ? [{ start, end: start + HOUR }] : isUnset(pin) ? pin.times : [{ start: pin.start, end: pin.end }]
  /** Times beyond the first offered, for people to mark */
  const more = r(filled.length - 1)
  const save = pin ? api.editPin : api.makePin
  const isPublic = r(pin?.visibility === "public")

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
      save({
        id:          pin?.id ?? randomBase64Url(16),
        title:       String(data.get("title")),
        description: String(data.get("description")),
        place:       String(data.get("place")),
        where:       String(data.get("where")),
        times,
        spots,
        visibility:  isPublic.peek() ? "public" : "link"
      }).then(
        saved => {
          capture(pin ? "pin_edited" : "pin_made", { times: times.length, spots: spots !== undefined, public: saved.visibility === "public" })
          keptPin(saved)
          void state.refreshPins()
          // In the form's place, so Back leaves rather than returning to a form that would post it again
          state.amend({ kind: "event", id: saved.id })
        },
        (error: Error) => {
          problem.value = error.message
          isSending.value = false
        }
      )
    }}>
      <Head title={pin ? "Edit event" : "New event"} />
      <label class="field"><span>What</span><input name="title" type="text" required maxlength={SHORT} placeholder="Tennis, anyone?" value={pin?.title} /></label>
      <Where chosen={pin?.place ?? place} />
      <label class="field"><span>Where exactly</span><input name="where" type="text" maxlength={SHORT} placeholder="Court 5, room 164, behind the MUB" value={pin?.where} /></label>
      <When time={filled[0]} />
      {/* Kept while hidden, so a time picked stays picked as another is added, each a day after the first to start */}
      {Array.from({ length: MAX_TIMES - 1 }, (_, i) => {
        const later = atClock(addDays(localDay(filled[0].start), i + 1), hhmm(filled[0].start))
        return <When hidden={r(() => more.value <= i)} time={filled[i + 1] ?? { start: later, end: later + HOUR }} label="Another time" />
      })}
      {r(() => more.value < MAX_TIMES - 1 && <button type="button" class="more" onclick={() => more.value++}>+ Another time</button>)}
      {r(() => more.value > 0 && <button type="button" class="more" onclick={() => more.value--}>− Remove a time</button>)}
      {r(() => more.value > 0 && <p class="muted">People mark the times that work, and you set one.</p>)}
      <label class="field"><span>Details</span><textarea name="description" rows={2} maxlength={LONG} placeholder="Any level. I have spare balls.">{pin?.description}</textarea></label>
      <div class="field-row">
        <label class="field"><span>Spots</span><input name="spots" type="number" inputmode="numeric" min="1" max={String(MAX_SPOTS)} placeholder="No limit" value={pin?.spots?.toString()} /></label>
        <div class="field">
          <span>Who can find it</span>
          <div class="segmented" role="group" aria-label="Who can find it">
            <button type="button" aria-pressed={r(() => isPublic.value ? "false" : "true")} onclick={() => isPublic.value = false}>Link only</button>
            <button type="button" aria-pressed={r(() => isPublic.value ? "true" : "false")} disabled={r(() => !verified.value)} title={r(() => verified.value ? undefined : "Takes a verified UNH email, in You")} onclick={() => isPublic.value = true}>Everyone</button>
          </div>
        </div>
      </div>
      {r(() => problem.value && <p class="notice" role="alert">{problem.value}</p>)}
      <button type="submit" class="button primary" disabled={isSending}>{pin ? "Save" : "Post it"}</button>
      {r(() => !verified.value && <p class="muted">Everyone on campus can find it once your UNH email is verified, in You.</p>)}
    </form>
  return form
}
