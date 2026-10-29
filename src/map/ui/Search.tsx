/** @jsxImportSource bruh/browser */

// One search, three fields: the home's, which answers with a page, and Directions' from and to, which take a place
// each. What's typed is searched among the places the map knows, and with Photon for addresses and anywhere else, the
// places nearer the trip's other end, or you, first, as are those chosen often on this device, which an empty field
// suggests. The home's and where to also find rooms to book, parking, instructors, sections, rooms, events and
// programs, each a labelled group, as do the fraternities and sororities whose houses the map doesn't place, and all
// that's local comes before anything Photon finds further off. A place found by the home's search opens its page, a
// stop its own, and anywhere else, as an address, directions there

import { type DerivativeNode, r, watch } from "bruh/reactive"
import { type Place, createNameSearch } from "../../places/search.mts"
import { CHAPTERS, aliasesOf, isPlaced } from "../../places/chapters.mts"
import * as photon from "../../places/photon.mts"
import { Icon } from "../../shell/ui.tsx"
import { state } from "../state/map.mts"
import { capture } from "../../shell/usage.tsx"
import { remembered } from "../../shell/state.mts"
import { CourseResults, Group } from "./Courses.tsx"
import { ParkingResults } from "./Parking.tsx"
import { ChapterKind, EventResults, placeNamed } from "./Pages.tsx"
import { ProgramResults } from "./Program.tsx"
import { SpaceResults, wantRoomsFor } from "./Rooms.tsx"
import { HOUR, hhmm, nextAt } from "../../shared/time.mts"

type Field = "search" | "from" | "to"

/** The field being typed in, whose suggestions lie over the home's list, or take the ways' place in directions */
export const editing = r<Field>()
const query = r("")
/** The places the map knows for what's typed, and Photon's further off, which list after everything local */
const suggestions = r<Place[]>([])
const elsewhere = r<Place[]>([])
/** Index into the options, where 0 is "Your location" in the planner's fields */
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

/** The trip's other end from the planner's field being typed in */
const otherEnd = () => {
  const field = editing.value
  return field && field !== "search" ? state[field === "from" ? "to" : "from"].value : undefined
}

/** Whether "Your location" is an option: in the planner's fields, unless the other end is you */
const offersYou = () =>
  editing.value !== "search" && otherEnd()?.isYou !== true

/** Suggestions, without the trip's other end, as a trip from somewhere to itself is no trip */
const options = r((): (Place | undefined)[] => {
  const other = otherEnd()
  // Derived rather than suggested, as the list shows the same moment the field is focused, and bruh 2.0.0-beta.5
  // would miss suggestions written then
  const places = query.value.trim()
    ? [...suggestions.value, ...elsewhere.value]
    : chosen.value.slice(0, FREQUENT).map(({ lat, lon, name }) => ({ lat, lon, name }))
  return [...offersYou() ? [undefined] : [], ...places.filter(option => !(other && isSamePlace(option, other)))]
})

/** Suggestions for what's typed: the places the map knows, and Photon's, once it's had a moment to type more */
const suggest = () => {
  const text = query.value.trim()
  // Search answers instructors, sections and rooms, so the courses load from its first keystroke
  if (text && editing.peek() !== "from") {
    state.wantCourses()
    wantRoomsFor(text)
  }
  const other = otherEnd()
  const fix = state.location.peek()
  const local = state.searchPlaces.value(text, {
    near: other && !other.isYou ? other : fix,
    uses: place => chosen.peek().find(({ name }) => name === place.name)?.uses ?? 0
  })
  suggestions.value = local
  elsewhere.value = []
  // The first place found, after "Your location" where that's offered
  active.value = text && offersYou() ? 1 : 0
  // Only Photon knows addresses
  const isAddress = /\d/.test(text)
  if (text.length < 3 || local.length >= FEW && !isAddress)
    return

  const names = new Set(local.map(place => place.name))
  const controller = new AbortController()
  const timer = setTimeout(() =>
    photon.search(text, controller.signal)
      // Photon names the town after the place, as "Stoke Hall, Durham"
      .then(found => elsewhere.value = found.filter(place => !names.has(place.name.split(", ")[0])))
      .catch(() => {}),
    300
  )
  return () => {
    clearTimeout(timer)
    controller.abort()
  }
}

/** Epoch seconds of a time of day, as the planner counts, as it next comes after a moment in epoch milliseconds */
const nextSeconds = (time: string, now: number) =>
  nextAt(time, now) / 1000

/** The stop a place is, by name and spot, where it's one the buses pick up at */
const stopOf = (place: Place) =>
  state.feed.peek().stops.find(stop => stop.name === place.name && stop.lat === place.lat && stop.lon === place.lon)

/**
 * Opens what the home's search found: a place the map knows by name, as its page; a stop, as its own; and anywhere
 * else, like an address, as directions there, leaving now
 */
const openFound = (place: Place) => {
  const stop = !placeNamed(place.name) && stopOf(place)
  if (placeNamed(place.name))
    state.go({ kind: "place", name: place.name })
  else if (stop)
    state.go({ kind: "stop", id: stop.id })
  else {
    state.from.value = undefined
    state.by.value = undefined
    void state.directTo(place)
    state.go({ kind: "directions" })
  }
}

/** undefined means the current location */
const choose = async (option: Place | undefined) => {
  const field = editing.peek()
  if (!field)
    return
  const focused = document.activeElement as HTMLElement | null
  if (field === "search") {
    if (option) {
      remember(option)
      capture("place_chosen", { field, you: false })
      focused?.blur()
      openFound(option)
    }
    return
  }
  state.locationProblem.value = undefined
  const place = option ?? await state.useCurrentLocation()
  if (!place)
    return
  state[field].value = place
  remember(place)
  capture("place_chosen", { field, you: option === undefined })
  focused?.blur()
}

const optionId = (i: number) => `place-option-${i}`

const PlaceInput = ({ field, label, placeholder }: { field: Field, label?: string, placeholder: string }) => {
  start()
  const place = field === "search" ? undefined : state[field]
  const isEditing = r(() => editing.value === field)

  const input: HTMLInputElement =
    <input
      type="text"
      inputmode="search"
      enterkeyhint="search"
      autocomplete="off"
      placeholder={placeholder}
      aria-label={label ?? placeholder}
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
        input.value = place?.peek()?.name ?? ""
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
  if (place)
    watch([place], () => {
      if (editing.peek() !== field)
        input.value = place.value?.name ?? ""
    })

  // Back from a page opened from search's results is back in the search, as it was typed, once the page has gone
  if (field === "search")
    watch([state.resumed, state.page], () => {
      const text = state.resumed.value
      if (text === undefined || state.page.value)
        return
      state.resumed.value = undefined
      // Once the home shows again, as a hidden field can't take focus
      setTimeout(() => {
        input.focus()
        input.value = query.value = text
      })
    })

  return (
    <label class={field === "search" ? "search-field" : "place-input"}>
      {field === "search" ? <Icon name="search" /> : <span class="place-label">{label}</span>}
      {input}
      {place && r(() => place.value &&
        <button
          type="button"
          class="clear"
          aria-label={`Clear ${label!.toLowerCase()}`}
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

/** A place to choose, by its index among the options, which the arrow keys move through */
const Option = ({ option, i }: { option: Place | undefined, i: number }) =>
  <li
    id={optionId(i)}
    role="option"
    aria-selected={r(() => active.value === i ? "true" : "false")}
    // Keeps focus in the field so it doesn't blur before choosing, which waits for the tap to end, as a drag that
    // scrolls the list cancels it instead. The click a touch would send after, which would land on whatever takes
    // the suggestions' place, like the week's list, is called off
    onpointerdown={event => event.preventDefault()}
    onpointerup={() => choose(option)}
    ontouchend={event => event.preventDefault()}
  >
    {option ? option.name : <><Icon name="locate" /> Your location</>}
  </li>

/** The chapters whose houses the map doesn't place, which search finds by any of their names as it does those it does */
const UNPLACED = CHAPTERS.filter(chapter => !isPlaced(chapter))
const searchUnplaced = createNameSearch(UNPLACED.map(chapter => [chapter.name, ...aliasesOf(chapter)]))

/** Search's chapters not on the map, each saying so, with its house's address where that's known, and linking to UNH's page for it */
const ChapterResults = ({ query }: { query: DerivativeNode<string> }) =>
  r(() => {
    const found = searchUnplaced(query.value).slice(0, 3).map(({ index }) => UNPLACED[index])
    return found.length > 0 && (
      <Group label="Fraternities and sororities">
        {found.map(chapter =>
          <li>
            <a class="row" href={chapter.url} target="_blank" rel="noopener">
              <span class="row-what">
                <strong class="truncate">{chapter.name}</strong>
                <span class="muted truncate"><ChapterKind chapter={chapter} /> · {chapter.house ? `${chapter.house.address}, not on the map` : "No house on the map"}</span>
              </span>
              <span class="row-state">›</span>
            </a>
          </li>
        )}
      </Group>
    )
  })

/**
 * The places for what's typed, and for the home's search and where to, rooms to book (Rooms.tsx), parking
 * (Parking.tsx), the instructors, sections and rooms (Courses.tsx), events (Pages.tsx) and programs (Program.tsx)
 * too, all before the places Photon finds further off
 */
export const Suggestions = () => {
  const isFar = (option: Place | undefined) => option !== undefined && elsewhere.value.includes(option)
  return <div class="suggested">
    <ul class="suggestions" id="place-options" role="listbox">
      {r(() => options.value.map((option, i) => !isFar(option) && <Option option={option} i={i} />))}
    </ul>
    {editing.peek() !== "from" && <><SpaceResults query={query} /><CourseResults query={query} /><ParkingResults query={query} /><EventResults query={query} /><ProgramResults query={query} /><ChapterResults query={query} /></>}
    {r(() => elsewhere.value.length > 0 &&
      <ul class="suggestions" role="listbox" aria-label="Further off">
        {options.value.map((option, i) => isFar(option) && <Option option={option} i={i} />)}
      </ul>
    )}
  </div>
}

// As long as the map's open, from its first field: what's typed is searched, and what's typed in the home's search,
// while it's searched, is kept for a page opened from its results to go back to
let isStarted = false
const start = () => {
  if (isStarted)
    return
  isStarted = true
  watch([query], suggest)
  watch([editing, query], () => {
    state.searching.value = editing.value === "search" && query.value.trim() ? query.value : undefined
  })
}

/** Whether something's typed in the home's search, so its suggestions lie over the week; focus alone changes nothing */
export const isSearching = r(() => editing.value === "search" && query.value.trim() !== "")

/** The home's search, with You in it, and Directions beside it */
export const SearchRow = () =>
  <div class="search-row">
    <PlaceInput field="search" placeholder="Search campus" />
    <button type="button" class="round" aria-label="You" title="You" onclick={() => state.go({ kind: "you" })}><Icon name="person" /></button>
    <button type="button" class="round" aria-label="Directions" title="Directions" onclick={() => state.go({ kind: "directions" })}><Icon name="navigate" /></button>
  </div>

const LocationNotice = () =>
  r(() =>
    state.isLocating.value      ? <p class="notice muted" role="status">Finding your location…</p> :
    state.locationProblem.value ? <p class="notice" role="status">{state.locationProblem.value}</p> :
                                  undefined
  )

/** Leave now, or be there by a time: the time is today's at that hour, or tomorrow's once today's is past; and saving the trip, once it's to somewhere by a time */
const When = () => {
  const { by, to } = state
  const time: HTMLInputElement =
    <input
      type="time"
      aria-label="Arrive by"
      onchange={() => {
        if (time.value)
          by.value = nextSeconds(time.value, Date.now())
      }}
    />
  watch([by], () => {
    time.value = by.value === undefined ? "" : hhmm(by.value * 1000)
  })
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
            by.value = nextSeconds(hhmm(Math.ceil(Date.now() / HOUR) * HOUR), Date.now())
          time.focus()
        }}
      >
        Arrive by
      </button>
      {time}
      {r(() => to.value !== undefined && by.value !== undefined && !state.isGoalSaved.value &&
        <button type="button" class="chip" onclick={() => { state.saveGoal(); capture("goal_saved") }}><Icon name="star" /> Save trip</button>
      )}
    </div>
  )
}

/** Where from and where to, and when: the directions page's fields */
export const Planner = () =>
  <>
    <form class="planner" onsubmit={event => event.preventDefault()}>
      <div class="planner-fields">
        <PlaceInput field="from" label="From" placeholder="Search or tap the map" />
        <PlaceInput field="to"   label="To"   placeholder="Where to?" />
      </div>
      <button
        type="button"
        class="round"
        aria-label="Swap start and destination"
        onclick={() => [state.from.value, state.to.value] = [state.to.value, state.from.value]}
      >
        <Icon name="swap" />
      </button>
      <When />
    </form>
    <LocationNotice />
  </>
