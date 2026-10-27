/** @jsxImportSource bruh/browser */

// Directions, a page of its own, reached from any place or occurrence, or the shortcut beside the search: where from
// and where to (Search.tsx), leave now or be there by a time, and the ways there (Itineraries.tsx), with a field's
// suggestions taking their place while it's typed in. The trip stays as it was when Back leaves it, for the day

import { r } from "bruh/reactive"
import { state } from "../state/map.mts"
import { Planner, editing } from "./Search.tsx"
import { Suggestions } from "./Search.tsx"
import { Itineraries } from "./Itineraries.tsx"

export const DirectionsView = () => {
  state.name.value = "Directions"
  const view =
    <div class="directions">
      <Planner />
      {r(() =>
        editing.value && editing.value !== "search" ? <Suggestions /> :
        state.from.value && state.to.value          ? <Itineraries /> :
                                                      undefined
      )}
    </div> as HTMLElement
  // Opened with nowhere to go yet, the question is where to
  if (!state.to.peek())
    setTimeout(() => view.querySelector<HTMLInputElement>("input[placeholder='Where to?']")?.focus())
  return view
}
