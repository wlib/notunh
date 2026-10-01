/** @jsxImportSource bruh/browser */

import { type Route, routeLabel } from "../feed.mts"
import { feed, selectedStop } from "../state.mts"
import { ClockTime } from "../../shell/intl.tsx"

export const route = (id: string) => feed.routesById.get(id)!

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
  <button type="button" class="stop-link" onclick={() => selectedStop.value = stop}>
    {feed.stops[stop].name}
  </button>
