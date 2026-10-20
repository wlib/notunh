/** @jsxImportSource bruh/browser */

// A stop's next buses, as forecast: each route's next departures, live where the map is following the bus. A route
// that runs by headway with no bus followed shows how often its buses come and how soon the next likely does
// instead, as its timetable says nothing of when they actually will

import { r, type SourceNode } from "bruh/reactive"
import { canBoard } from "../../transit/feed.mts"
import type { Run } from "../../transit/models/forecast.mts"
import { waitEstimate } from "../../transit/models/estimates.mts"
import type { Place } from "../../places/search.mts"
import { List, Minutes } from "../../shell/intl.tsx"
import { Icon } from "../../shell/ui.tsx"
import { RouteBadge, Time, minutes, route } from "./common.tsx"
import { state } from "../state/map.mts"

const SCHEDULE_HOURS = 3
// Sooner than this, a departure shows how many minutes away it is rather than when
const SOON = 30 * 60 // s
const SHOWN = 3

export const StopView = ({ stop }: { stop: number }) => {
  const { id, name, lat, lon } = state.feed.peek().stops[stop]
  const place: Place = { lat, lon, name }
  const pick = (target: SourceNode<Place | undefined>) => () => {
    target.value = place
    state.selectedStop.value = undefined
  }

  /** Each route's departures from here in the next few hours, soonest first, its soonest route first */
  const departures = r(() => {
    const byRoute = new Map<string, { time: number, run: Run }[]>()
    for (const run of state.runs.value)
      run.trip.stops.forEach((s, position) => {
        const time = run.departures[position]
        if (s === stop && canBoard(run.trip, position) && time >= state.now.value && time < state.now.value + SCHEDULE_HOURS * 3600)
          byRoute.set(run.trip.route, [...byRoute.get(run.trip.route) ?? [], { time, run }])
      })
    return [...byRoute]
      .map(([id, times]) => {
        const sorted = times.sort((a, b) => a.time - b.time)
        const isHeadway = !sorted[0].run.trip.timepoints.length
        const live = sorted.filter(({ run }) => run.isLive)
        // A route running by headway with no bus followed here soon has only its usual frequency to go on
        const wait = isHeadway && !live.length ? waitEstimate(state.model.value, id, state.now.value) : undefined
        return { route: route(id), headsign: sorted[0].run.trip.headsign, shown: isHeadway && wait ? [] : sorted.slice(0, SHOWN), wait }
      })
      .sort((a, b) => (a.shown[0]?.time ?? state.now.value + (a.wait?.wait ?? 0)) - (b.shown[0]?.time ?? state.now.value + (b.wait?.wait ?? 0)))
  })

  return (
    <section class="stop-view">
      <header>
        <div>
          <h2>{name}</h2>
          <p class="muted">Stop {id}</p>
        </div>
        <button type="button" class="close" aria-label="Close" onclick={() => state.selectedStop.value = undefined}>
          <Icon name="close" />
        </button>
      </header>
      <div class="stop-actions">
        <button type="button" class="button" onclick={pick(state.from)}>Directions from here</button>
        <button type="button" class="button" onclick={pick(state.to)}>Directions to here</button>
      </div>
      {r(() => {
        if (!departures.value.length)
          return <p class="muted">No buses in the next few hours.</p>
        return (
          <>
            <ul class="arrivals">
              {departures.value.map(({ route, headsign, shown, wait }) =>
                <li>
                  <RouteBadge route={route} />
                  <span class="arrival-direction">{headsign}</span>
                  {wait
                    ? <span class="arrival-times muted">
                      Every <Minutes value={minutes(wait.headway)} />, half the time within <Minutes value={minutes(wait.wait)} />
                    </span>
                    : <span class={{ "arrival-times": true, muted: !shown[0].run.isLive }}>
                      {shown[0].run.isLive && <span class="dot" title="Live" />}
                      <List type="unit" items={shown.map(({ time }) =>
                        time - state.now.value < SOON ? <Minutes value={Math.max(1, minutes(time - state.now.value))} /> : <Time seconds={time} />
                      )} />
                    </span>}
                </li>
              )}
            </ul>
            <p class="muted legend"><span class="dot" /> Live from the bus, the rest from the schedule or how often buses come</p>
          </>
        )
      })}
    </section>
  )
}
