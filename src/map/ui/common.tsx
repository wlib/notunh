/** @jsxImportSource bruh/browser */

import { type Route, routeLabel } from "../../transit/feed.mts"
import { ClockTime } from "../../shell/intl.tsx"
import { state } from "../state/map.mts"
import type { Place } from "../../places/search.mts"
import { walkSeconds } from "../../routing/walks.mts"

export const route = (id: string) => state.feed.peek().routesById.get(id)!

/** Epoch seconds, as plans and schedules count time */
export const Time = ({ seconds }: { seconds: number }) =>
  <ClockTime at={new Date(seconds * 1000)} />

/** Whole minutes in some seconds, at least one */
export const minutes = (seconds: number) =>
  Math.max(1, Math.round(seconds / 60))

export const RouteBadge = ({ route }: { route: Route }) =>
  <span class="route-badge" style={{ "background-color": route.color, "color": route.text }}>
    {routeLabel(route)}
  </span>

/** A stop's name, by its index in the timetable, which opens its page */
export const StopLink = ({ stop }: { stop: number }) =>
  <button type="button" class="stop-link" onclick={() => state.go({ kind: "stop", id: state.feed.peek().stops[stop].id })}>
    {state.feed.peek().stops[stop].name}
  </button>

/** Epoch ms, as the page's clock ticks, followed */
export const nowMs = () =>
  state.now.value * 1000

/** Seconds to walk to a place from where you are, while that's known */
export const walkTo = (place: Place | undefined) => {
  const fix = state.location.value
  return fix && place ? walkSeconds(state.walks.value.between({ lat: fix.lat, lon: fix.lon }, place).meters) : undefined
}
