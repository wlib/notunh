/** @jsxImportSource bruh/browser */

// Every route, to show or hide on the map and to pick one out, and how many buses are live

import { r } from "bruh/reactive"
import { feed, lastUpdate, isLiveDown, liveCounts, runningToday, shownRoutes, chosenRoutes, pickedRoute } from "../state.mts"
import { Count, Plural } from "../../shell/intl.tsx"
import { RouteBadge, route } from "./common.tsx"

export const RouteList = () =>
  <section class="routes">
    <h2 class="eyebrow">Routes</h2>
    <ul>
      {feed.routes.map(({ id, long }) => {
        const count = r(() => liveCounts.value.get(id) ?? 0)
        const isRunning = r(() => runningToday.value.has(id))
        const isPicked = r(() => pickedRoute.value === id)
        const checkbox: HTMLInputElement =
          <input
            type="checkbox"
            aria-label={`Show ${long}`}
            checked={r(() => shownRoutes.value.has(id))}
            onchange={() => {
              const next = new Set(shownRoutes.value)
              if (checkbox.checked)
                next.add(id)
              else
                next.delete(id)
              chosenRoutes.value = next
            }}
          />

        return (
          <li class={{ "not-running": r(() => !isRunning.value) }}>
            {checkbox}
            <button
              type="button"
              aria-pressed={r(() => isPicked.value ? "true" : "false")}
              onclick={() => {
                pickedRoute.value = isPicked.peek() ? undefined : id
                // Picking out a hidden route shows it too
                if (pickedRoute.peek() && !shownRoutes.peek().has(id))
                  chosenRoutes.value = new Set([...shownRoutes.peek(), id])
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
      })}
    </ul>
  </section>

export const Status = () =>
  <span class="status">
    {r(() => {
      if (isLiveDown.value)
        return "Live updates unavailable"
      if (lastUpdate.value === undefined)
        return "Connecting…"
      const count = [...liveCounts.value.values()].reduce((a, b) => a + b, 0)
      return <><span class="dot" /><Plural value={count} one={<><Count value={1} /> bus live</>} other={<><Count value={count} /> buses live</>} /></>
    })}
  </span>
