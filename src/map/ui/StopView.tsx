/** @jsxImportSource bruh/browser */

// A stop's next buses: Umo's predictions, with the schedule for routes it isn't predicting

import { r, type SourceNode } from "bruh/reactive"
import type { Route } from "../feed.mts"
import { type Place, timeAt } from "../plan.mts"
import { feed, now, runs, from, to, selectedStop, stopPredictions } from "../state.mts"
import { Count, List } from "../../shell/intl.tsx"
import { Icon } from "../../shell/ui.tsx"
import { RouteBadge, Time, route } from "./common.tsx"

const SCHEDULE_HOURS = 3

export const StopView = ({ stop }: { stop: number }) => {
  const { id, name, lat, lon } = feed.stops[stop]
  const place: Place = { lat, lon, name }
  const pick = (target: SourceNode<Place | undefined>) => () => {
    target.value = place
    selectedStop.value = undefined
  }

  const scheduled = r(() => {
    const departures: { route: Route, time: number, headsign: string }[] = []
    for (const run of runs.value)
      run.trip.stops.forEach((s, position) => {
        const time = timeAt(run, position)
        if (s === stop && position + 1 < run.trip.stops.length && time >= now.value && time < now.value + SCHEDULE_HOURS * 3600)
          departures.push({ route: route(run.trip.route), time, headsign: run.trip.headsign })
      })
    return departures.sort((a, b) => a.time - b.time)
  })

  return (
    <section class="stop-view">
      <header>
        <div>
          <h2>{name}</h2>
          <p class="muted">Stop {id}</p>
        </div>
        <button type="button" class="close" aria-label="Close" onclick={() => selectedStop.value = undefined}>
          <Icon name="close" />
        </button>
      </header>
      <div class="stop-actions">
        <button type="button" class="button" onclick={pick(from)}>Directions from here</button>
        <button type="button" class="button" onclick={pick(to)}>Directions to here</button>
      </div>
      {r(() => {
        if (!stopPredictions.value)
          return <p class="muted">Loading arrivals…</p>

        const predicted = stopPredictions.value.filter(entry => entry.values.length && feed.routesById.has(entry.route.id))
        const predictedRoutes = new Set(predicted.map(entry => entry.route.id))
        const fallback = scheduled.value.filter(departure => !predictedRoutes.has(departure.route.id)).slice(0, 6)

        if (!predicted.length && !fallback.length)
          return <p class="muted">No buses in the next few hours.</p>

        return (
          <>
            <ul class="arrivals">
              {predicted.map(({ route: { id }, values }) =>
                <li>
                  <RouteBadge route={route(id)} />
                  <span class="arrival-direction">{values[0].direction.name}</span>
                  <span class={{ "arrival-times": true, muted: values[0].affectedByLayover }}>
                    {!values[0].affectedByLayover && <span class="dot" title="Live" />}
                    <List type="unit" items={values.slice(0, 3).map(value => value.minutes === 0 ? "Now" : <Count value={value.minutes} />)} />
                    {values.some(value => value.minutes > 0) && " min"}
                  </span>
                </li>
              )}
              {fallback.map(departure =>
                <li>
                  <RouteBadge route={departure.route} />
                  <span class="arrival-direction">{departure.headsign}</span>
                  <span class="arrival-times muted"><Time seconds={departure.time} /></span>
                </li>
              )}
            </ul>
            <p class="muted legend"><span class="dot" /> Live from the bus, the rest from the schedule</p>
          </>
        )
      })}
    </section>
  )
}
