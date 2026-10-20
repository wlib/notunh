/** @jsxImportSource bruh/browser */

import { type Route, routeLabel } from "../../transit/feed.mts"
import { ClockTime } from "../../shell/intl.tsx"
import { state } from "../state/map.mts"

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

export const StopLink = ({ stop }: { stop: number }) =>
  <button type="button" class="stop-link" onclick={() => state.selectedStop.value = stop}>
    {state.feed.peek().stops[stop].name}
  </button>
