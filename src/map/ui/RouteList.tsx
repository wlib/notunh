/** @jsxImportSource bruh/browser */

// Every route, to show or hide on the map and to pick one out, and how many buses are live

import { r } from "bruh/reactive"
import { Count, Plural } from "../../shell/intl.tsx"
import { toggled } from "../../shell/state.mts"
import { RouteBadge, route } from "./common.tsx"
import { state } from "../state/map.mts"

export const RouteList = () =>
  <section class="routes">
    <h2 class="eyebrow">Routes</h2>
    <ul>
      {r(() => state.feed.value.routes.map(({ id, long }) => {
        const count = r(() => state.liveCounts.value.get(id) ?? 0)
        const isRunning = r(() => state.runningToday.value.has(id))
        const isPicked = r(() => state.pickedRoute.value === id)
        return (
          <li class={{ "not-running": r(() => !isRunning.value) }}>
            <input
              type="checkbox"
              aria-label={`Show ${long}`}
              checked={r(() => state.shownRoutes.value.has(id))}
              onchange={() => state.chosenRoutes.value = toggled(state.shownRoutes.peek(), id)}
            />
            <button
              type="button"
              aria-pressed={r(() => isPicked.value ? "true" : "false")}
              onclick={() => {
                state.pickedRoute.value = isPicked.peek() ? undefined : id
                // Picking out a hidden route shows it too
                if (state.pickedRoute.peek() && !state.shownRoutes.peek().has(id))
                  state.chosenRoutes.value = new Set([...state.shownRoutes.peek(), id])
              }}
            >
              <RouteBadge route={route(id)} />
              <span>{long}</span>
              <span class="route-status">
                {r(() =>
                  count.value     ? <><Count value={count.value} /> live</> :
                  isRunning.value ? "None out now" :
                                    "Not today"
                )}
              </span>
            </button>
          </li>
        )
      }))}
    </ul>
  </section>

export const Status = () => {
  // Only buses on the routes the map shows, so the two agree, and as a number, so the header only redraws when
  // the count changes rather than with every poll
  const count = r(() =>
    [...state.liveCounts.value].reduce((total, [route, live]) => total + (state.shownRoutes.value.has(route) ? live : 0), 0)
  )
  return (
    <span class="status">
      {r(() => {
        if (state.isLiveDown.value)
          return "Live updates unavailable"
        if (state.lastUpdate.value === undefined)
          return "Connecting…"
        return <><span class="dot" /><Plural value={count.value} one={<><Count value={1} /> bus live</>} other={<><Count value={count.value} /> buses live</>} /></>
      })}
    </span>
  )
}
