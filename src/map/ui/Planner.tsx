/** @jsxImportSource bruh/browser */

// Where from and where to, searched as you type among the places the map knows, and with Photon for addresses and
// anywhere else. Places nearer the trip's other end, or you, come first, as do those chosen often on this device,
// which an empty field suggests. Under them, whether to leave now or to be there by a time, and the goals saved on
// this device, each a place and a time to be there by, which a tap plans from where you are

import { r, watch } from "bruh/reactive"
import type { Place } from "../../places/search.mts"
import * as photon from "../../places/photon.mts"
import { Icon } from "../../shell/ui.tsx"
import { state } from "../state/map.mts"
import { capture } from "../../shell/usage.tsx"
import { remembered } from "../../shell/state.mts"
import { Time } from "./common.tsx"
import { HOUR, addDays, atClock, hhmm, localDay } from "../../shared/time.mts"

type Field = "from" | "to"

/** The field being typed in, whose suggestions take the place of the rest of the panel */
export const editing = r<Field>()
const query = r("")
const suggestions = r<Place[]>([])
/** Index into the options, where 0 is "Your location" */
const active = r(0)

// Fewer places than this found here, Photon is asked too
const FEW      = 3
const FREQUENT = 5  // places chosen often, suggested before anything's typed
const KEPT     = 50 // places remembered as chosen, the most often chosen kept

type Chosen = Place & { uses: number }

const isChosen = (value: unknown): value is Chosen => {
  const { lat, lon, name, uses }: { lat?: unknown, lon?: unknown, name?: unknown, uses?: unknown } = Object(value)
  return typeof lat === "number" && typeof lon === "number" && typeof name === "string" && typeof uses === "number"
}

/** The places chosen on this device, most often first, and how many times each */
const chosen = remembered<Chosen[]>("map-chosen", stored => Array.isArray(stored) ? stored.filter(isChosen) : [])

const isSamePlace = (a: Place, b: Place) =>
  a.name === b.name && a.lat === b.lat && a.lon === b.lon

/** Counts a place chosen, unless it's you or a dropped pin, which aren't places to choose again */
const remember = (place: Place) => {
  if (place.isYou || place.name === "Dropped pin")
    return
  const uses = 1 + (chosen.peek().find(other => isSamePlace(other, place))?.uses ?? 0)
  const { lat, lon, name } = place
  chosen.value = [{ lat, lon, name, uses }, ...chosen.peek().filter(other => !isSamePlace(other, place))]
    .sort((a, b) => b.uses - a.uses)
    .slice(0, KEPT)
}

/** The trip's other end from the field being typed in */
const otherEnd = () => {
  const field = editing.value
  return field && state[field === "from" ? "to" : "from"].value
}

/** Suggestions, without the trip's other end, as a trip from somewhere to itself is no trip */
const options = r(() => {
  const other = otherEnd()
  const isOther = (option: Place | undefined) =>
    option ? other !== undefined && isSamePlace(option, other) : other?.isYou === true
  // Derived rather than suggested, as the list shows the same moment the field is focused, and bruh 2.0.0-beta.5
  // would miss suggestions written then
  const places = query.value.trim()
    ? suggestions.value
    : chosen.value.slice(0, FREQUENT).map(({ lat, lon, name }) => ({ lat, lon, name }))
  return [undefined, ...places].filter(option => !isOther(option))
})

/** Suggestions for what's typed: the places the map knows, and Photon's, once it's had a moment to type more */
const suggest = () => {
  const text = query.value.trim()
  const other = otherEnd()
  const fix = state.location.peek()
  const local = state.searchPlaces.value(text, {
    near: other && !other.isYou ? other : fix,
    uses: place => chosen.peek().find(({ name }) => name === place.name)?.uses ?? 0
  })
  suggestions.value = local
  // The first place found, after "Your location" where that's suggested
  active.value = text && !other?.isYou ? 1 : 0
  // Only Photon knows addresses
  const isAddress = /\d/.test(text)
  if (text.length < 3 || local.length >= FEW && !isAddress)
    return

  const names = new Set(local.map(place => place.name))
  const controller = new AbortController()
  const timer = setTimeout(() =>
    photon.search(text, controller.signal)
      // Photon names the town after the place, as "Stoke Hall, Durham"
      .then(found => suggestions.value = [...local, ...found.filter(place => !names.has(place.name.split(", ")[0]))])
      .catch(() => {}),
    300
  )
  return () => {
    clearTimeout(timer)
    controller.abort()
  }
}

/** A goal saved on this device: a place, and a time of day on Durham's clock to be there by */
type Saved = Place & { by: string }

const isSaved = (value: unknown): value is Saved => {
  const { lat, lon, name, by }: { lat?: unknown, lon?: unknown, name?: unknown, by?: unknown } = Object(value)
  return typeof lat === "number" && typeof lon === "number" && typeof name === "string" && typeof by === "string" && /^\d\d:\d\d$/.test(by)
}

const goals = remembered<Saved[]>("map-goals", stored => Array.isArray(stored) ? stored.filter(isSaved) : [])

/** Epoch seconds of a time of day, today as of a moment in epoch milliseconds, or tomorrow if that's already past */
const nextAt = (time: string, now: number) => {
  const today = atClock(localDay(now), time)
  return (today > now ? today : atClock(addDays(localDay(now), 1), time)) / 1000
}

/** When a time of day next comes, as of now, said to be tomorrow's once today's is past */
const Next = ({ time }: { time: string }) =>
  r(() => {
    const now = state.now.value * 1000
    const at = nextAt(time, now)
    return <><Time seconds={at} />{localDay(at * 1000) !== localDay(now) && " tomorrow"}</>
  })

/** undefined means the current location */
const choose = async (option: Place | undefined) => {
  const field = editing.peek()
  if (!field)
    return
  state.locationProblem.value = undefined
  const place = option ?? await state.useCurrentLocation()
  if (!place)
    return
  state[field].value = place
  state.selectedStop.value = undefined
  remember(place)
  capture("place_chosen", { field, you: option === undefined })
  const focused = document.activeElement as HTMLElement | null
  focused?.blur()
}

const optionId = (i: number) => `place-option-${i}`

const PlaceInput = ({ field, label, placeholder }: { field: Field, label: string, placeholder: string }) => {
  const place = state[field]
  const isEditing = r(() => editing.value === field)

  const input: HTMLInputElement =
    <input
      type="text"
      inputmode="search"
      enterkeyhint="search"
      autocomplete="off"
      placeholder={placeholder}
      role="combobox"
      aria-autocomplete="list"
      aria-controls="place-options"
      aria-expanded={r(() => isEditing.value ? "true" : "false")}
      aria-activedescendant={r(() => isEditing.value ? optionId(active.value) : undefined)}
      onfocus={() => {
        editing.value = field
        query.value = ""
        input.select()
      }}
      onblur={() => {
        if (editing.peek() === field)
          editing.value = undefined
        input.value = place.peek()?.name ?? ""
      }}
      oninput={() => query.value = input.value}
      onkeydown={event => {
        const count = options.peek().length
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault()
          active.value = (active.peek() + (event.key === "ArrowDown" ? 1 : count - 1)) % count
        }
        else if (event.key === "Enter")
          choose(options.peek()[active.peek()])
        else if (event.key === "Escape")
          input.blur()
      }}
    />

  // Not while typing, as a trip from or to you changes as you walk
  watch([place], () => {
    if (editing.peek() !== field)
      input.value = place.value?.name ?? ""
  })

  return (
    <label class="place-input">
      <span class="place-label">{label}</span>
      {input}
      {r(() => place.value &&
        <button
          type="button"
          class="clear"
          aria-label={`Clear ${label.toLowerCase()}`}
          onpointerdown={event => event.preventDefault()}
          onclick={() => {
            place.value = undefined
            // A time to be there by goes with where, so it's cleared along
            if (field === "to")
              state.by.value = undefined
            input.focus()
          }}
        >
          <Icon name="close" />
        </button>
      )}
    </label>
  )
}

export const Suggestions = () =>
  <ul class="suggestions" id="place-options" role="listbox">
    {r(() => options.value.map((option, i) =>
      <li
        id={optionId(i)}
        role="option"
        aria-selected={r(() => active.value === i ? "true" : "false")}
        // Keeps focus in the field so it doesn't blur before choosing, which waits for the tap to end, as a drag that
        // scrolls the list cancels it instead
        onpointerdown={event => event.preventDefault()}
        onpointerup={() => choose(option)}
      >
        {option ? option.name : <><Icon name="locate" /> Your location</>}
      </li>
    ))}
  </ul>

const LocationNotice = () =>
  r(() =>
    state.isLocating.value      ? <p class="notice muted" role="status">Finding your location…</p> :
    state.locationProblem.value ? <p class="notice" role="status">{state.locationProblem.value}</p> :
                                  undefined
  )

/** Leave now, or be there by a time: the time is today's at that hour, or tomorrow's once today's is past */
const When = () => {
  const { by, to } = state
  const time: HTMLInputElement =
    <input
      type="time"
      aria-label="Arrive by"
      onchange={() => {
        if (time.value)
          by.value = nextAt(time.value, Date.now())
      }}
    />
  watch([by], () => {
    time.value = by.value === undefined ? "" : hhmm(by.value * 1000)
  })
  const isSaved = r(() => to.value !== undefined && by.value !== undefined && goals.value.some(goal => goal.name === to.value!.name && goal.by === hhmm(by.value! * 1000)))
  const save = () => {
    const place = to.peek()
    if (!place || by.peek() === undefined)
      return
    const saved: Saved = { lat: place.lat, lon: place.lon, name: place.name, by: hhmm(by.peek()! * 1000) }
    goals.value = [saved, ...goals.peek().filter(goal => !(goal.name === saved.name && goal.by === saved.by))]
    capture("goal_saved")
  }
  return (
    <div class="when" role="group" aria-label="When">
      <button type="button" class="chip" aria-pressed={r(() => by.value === undefined ? "true" : "false")} onclick={() => by.value = undefined}>Leave now</button>
      <button
        type="button"
        class="chip"
        aria-pressed={r(() => by.value === undefined ? "false" : "true")}
        onclick={() => {
          // The next whole hour, until a time is picked
          if (by.peek() === undefined)
            by.value = nextAt(hhmm(Math.ceil(Date.now() / HOUR) * HOUR), Date.now())
          time.focus()
        }}
      >
        Arrive by
      </button>
      {time}
      {r(() => to.value !== undefined && by.value !== undefined && !isSaved.value &&
        <button type="button" class="chip" onclick={save}>Save</button>
      )}
    </div>
  )
}

/** The goals saved here, shown while no trip is planned: a tap plans getting there by its time from where you are */
const Goals = () =>
  r(() => !state.to.value && goals.value.length > 0 &&
    <ul class="goals chips" aria-label="Saved goals">
      {goals.value.map(goal =>
        <li>
          <button
            type="button"
            class="chip"
            onclick={() => {
              state.from.value = undefined
              state.by.value = nextAt(goal.by, Date.now())
              void state.directTo({ lat: goal.lat, lon: goal.lon, name: goal.name })
              capture("goal_opened")
            }}
          >
            {goal.name} · <Next time={goal.by} />
          </button>
          <button type="button" class="clear" aria-label={`Forget ${goal.name}`} onclick={() => goals.value = goals.peek().filter(other => other !== goal)}>
            <Icon name="close" />
          </button>
        </li>
      )}
    </ul>
  )

export const Planner = () => {
  // As long as the planner's shown, which is as long as the page
  watch([query], suggest)
  return <>
    <Goals />
    <form class="planner" onsubmit={event => event.preventDefault()}>
      <div class="planner-fields">
        <PlaceInput field="from" label="From" placeholder="Search or tap the map" />
        <PlaceInput field="to"   label="To"   placeholder="Where to?" />
      </div>
      <button
        type="button"
        class="swap"
        aria-label="Swap start and destination"
        onclick={() => [state.from.value, state.to.value] = [state.to.value, state.from.value]}
      >
        <Icon name="swap" />
      </button>
      <When />
    </form>
    <LocationNotice />
  </>
}
