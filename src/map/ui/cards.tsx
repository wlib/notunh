/** @jsxImportSource bruh/browser */

// A card that opens on the map at a spot, to get directions to or from it

import { r, type SourceNode } from "bruh/reactive"
import type { Place } from "../plan.mts"
import { nameAt, type MapHints } from "../osm.mts"
import { from, to } from "../state.mts"

export const PlaceCard = ({ place, hints, close }: { place: Place, hints: MapHints, close: () => void }) => {
  const found = nameAt(place, hints).catch(() => undefined)
  const name = r<string>()
  found.then(result => name.value = result ?? place.name)

  // Use the name if it's known, and fill it in once it is
  const pick = (target: SourceNode<Place | undefined>) => () => {
    const chosen = { ...place, name: name.peek() ?? place.name }
    target.value = chosen
    close()
    found.then(result => {
      if (result && target.peek() === chosen)
        target.value = { ...chosen, name: result }
    })
  }

  return (
    <div class="map-card-body">
      <strong>{r(() => name.value ?? "Finding this place…")}</strong>
      <div class="map-card-actions">
        <button type="button" class="button" onclick={pick(from)}>Directions from here</button>
        <button type="button" class="button" onclick={pick(to)}>Directions to here</button>
      </div>
    </div>
  )
}
