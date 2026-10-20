/** @jsxImportSource bruh/browser */

// Where from and where to, searched as you type among the places the map knows, and with Photon for addresses and
// anywhere else

import { r, watch } from "bruh/reactive"
import type { Place } from "../../places/search.mts"
import * as photon from "../../places/photon.mts"
import { Icon } from "../../shell/ui.tsx"
import { state } from "../state/map.mts"

type Field = "from" | "to"

/** The field being typed in, whose suggestions take the place of the rest of the panel */
export const editing = r<Field>()
const query = r("")
const suggestions = r<Place[]>([])
/** Index into the options, where 0 is "Your location" */
const active = r(0)

const options = r(() => [undefined, ...suggestions.value])

// Fewer places than this found here, Photon is asked too
const FEW = 3

/** Suggestions for what's typed: the places the map knows, and Photon's, once it's had a moment to type more */
const suggest = () => {
  const text = query.value.trim()
  const local = state.searchPlaces.value(text)
  suggestions.value = local
  active.value = text ? 1 : 0
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
    state.isLocating.value      ? <p class="notice muted" role="status">Finding your location…</p> :
    state.locationProblem.value ? <p class="notice" role="status">{state.locationProblem.value}</p> :
                                  undefined
  )

export const Planner = () => {
  // As long as the planner's shown, which is as long as the page
  watch([query], suggest)
  return <>
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
    </form>
    <LocationNotice />
  </>
}
