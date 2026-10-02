/** @jsxImportSource bruh/browser */

// Where from and where to, searched by stop name and with Photon as you type

import { r, watch, type SourceNode } from "bruh/reactive"
import type { Place } from "../plan.mts"
import { searchPlaces } from "../osm.mts"
import { feed, from, to, selectedStop, isLocating, useCurrentLocation } from "../state.mts"
import { locationProblem } from "../location.mts"
import { Icon } from "../../shell/ui.tsx"

type Field = "from" | "to"
const places: Record<Field, SourceNode<Place | undefined>> = { from, to }

/** The field being typed in, whose suggestions take the place of the rest of the panel */
export const editing = r<Field>()
const query = r("")
const suggestions = r<Place[]>([])
/** Index into the options, where 0 is "Your location" */
const active = r(0)

const options = r(() => [undefined, ...suggestions.value])

watch([query], () => {
  const text = query.value.trim()
  const lower = text.toLowerCase()
  const stops = text
    ? feed.stops
      .filter(stop => stop.pickup !== false && stop.name.toLowerCase().includes(lower))
      .slice(0, 4)
      .map(({ lat, lon, name }) => ({ lat, lon, name }))
    : []
  suggestions.value = stops
  active.value = text ? 1 : 0
  if (text.length < 3)
    return

  const controller = new AbortController()
  const timer = setTimeout(() =>
    searchPlaces(text, controller.signal)
      .then(found => suggestions.value = [...stops, ...found])
      .catch(() => {}),
    300
  )
  return () => {
    clearTimeout(timer)
    controller.abort()
  }
})

/** undefined means the current location */
const choose = async (option: Place | undefined) => {
  const field = editing.peek()
  if (!field)
    return
  locationProblem.value = undefined
  const place = option ?? await useCurrentLocation()
  if (!place)
    return
  places[field].value = place
  selectedStop.value = undefined
  const focused = document.activeElement as HTMLElement | null
  focused?.blur()
}

const optionId = (i: number) => `place-option-${i}`

const PlaceInput = ({ field, label, placeholder }: { field: Field, label: string, placeholder: string }) => {
  const place = places[field]
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

  watch([place], () => {
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
        onpointerdown={event => {
          // Keep focus in the field so it doesn't blur before choosing
          event.preventDefault()
          choose(option)
        }}
      >
        {option ? option.name : <><Icon name="locate" /> Your location</>}
      </li>
    ))}
  </ul>

const LocationNotice = () =>
  r(() =>
    isLocating.value      ? <p class="notice muted" role="status">Finding your location…</p> :
    locationProblem.value ? <p class="notice" role="status">{locationProblem.value}</p> :
                            undefined
  )

export const Planner = () =>
  <>
    <form class="planner" onsubmit={event => event.preventDefault()}>
      <div class="planner-fields">
        <PlaceInput field="from" label="From" placeholder="Search or tap the map" />
        <PlaceInput field="to"   label="To"   placeholder="Where to?" />
      </div>
      <button
        type="button"
        class="swap"
        aria-label="Swap start and destination"
        onclick={() => [from.value, to.value] = [to.value, from.value]}
      >
        <Icon name="swap" />
      </button>
    </form>
    <LocationNotice />
  </>
