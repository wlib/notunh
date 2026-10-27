/** @jsxImportSource bruh/browser */

// A bus's page: its route, its stops still to come, with yours picked out, and saying you're on it; and asking about
// a bus you seem to be on

import { r } from "bruh/reactive"
import { runOf } from "../../transit/models/forecast.mts"
import { Minutes, ago } from "../../shell/intl.tsx"
import { RouteBadge, StopLink, Time, route } from "./common.tsx"
import { state } from "../state/map.mts"
import { capture } from "../../shell/usage.tsx"
import { Head } from "./Pages.tsx"

// A stop the bus left this recently still shows, as it may just be pulling out
const JUST_LEFT = 30 // s
// Sooner than this, a stop shows how many minutes away it is rather than when
const SOON = 30 * 60 // s

/** Epoch milliseconds, ticking every second for "Last seen 5s ago" */
const second = r(Date.now())
setInterval(() => second.value = Date.now(), 1000)

export const BusView = ({ id }: { id: string }) => {
  const vehicle = r(() => state.vehicles.value.find(vehicle => vehicle.id === id))
  const isRiding = r(() => state.riding.value === id)
  const run = r(() => runOf(state.runs.value, vehicle.value ?? { id }, state.now.value))

  const Riding = () =>
    r(() => isRiding.value
      ? <button type="button" class="button" onclick={() => { state.ride(undefined); capture("bus_left") }}>I got off</button>
      : <button type="button" class="button primary" onclick={() => { state.ride(id); capture("bus_boarded", { suggested: false }) }}>I'm on this bus</button>
    )

  return <>
    {r(() => {
      const busRoute = vehicle.value?.route && state.feed.value.routesById.get(vehicle.value.route.id)
      if (!busRoute)
        return <>
          <Head title="A bus" />
          <p class="muted">{vehicle.value ? "This bus is on a route the timetable doesn't have." : "This bus stopped reporting."}</p>
          {isRiding.value && <div class="view-actions"><Riding /></div>}
        </>
      const isOnlyRoute = r(() => state.shownRoutes.value.size === 1 && state.shownRoutes.value.has(busRoute.id))
      // Loops are often signed with the route's own name, which says nothing more
      const toward = run.value?.trip.headsign ?? vehicle.value?.dir?.dirNameShort
      return <>
        <Head kind={<><RouteBadge route={busRoute} />{toward && toward !== busRoute.long && <> toward {toward}</>}</>} title={busRoute.long} />
        <p class="view-facts">
          {r(() => isRiding.value ? "You're on this bus" : `Last seen ${ago(vehicle.value ? state.ageOf(vehicle.value, second.value) : 0)}`)}
        </p>
        <div class="view-actions">
          <Riding />
          <button type="button" class="button" onclick={() => state.chosenRoutes.value = isOnlyRoute.peek() ? undefined : new Set([busRoute.id])}>
            {r(() => isOnlyRoute.value ? "Show all routes" : "Only this route")}
          </button>
        </div>
      </>
    })}
    {r(() => {
      const current = run.value
      if (!current)
        return <p class="muted">Umo isn't saying which stops this bus has next.</p>

      // The stop an itinerary gets off this bus at, and where it gets on if you're not on yet
      const leg = state.itinerary.value?.legs.find(leg =>
        leg.kind === "ride" && leg.run.trip.id === current.trip.id && leg.run.base === current.base
      )
      const [getOn, getOff] = leg?.kind === "ride" ? [leg.fromPosition, leg.toPosition] : []
      const positions = current.trip.stops
        .map((_, position) => position)
        .filter(position => current.departures[position] >= state.now.value - JUST_LEFT)
      const isNext = getOff !== undefined && positions[0] === getOff && isRiding.value

      return (
        <>
          {isNext && <p class="notice cue" role="status">Your stop is next</p>}
          <ol class="bus-stops">
            {positions.map(position => {
              const time = current.departures[position]
              const isYours = position === getOff
              return (
                <li class={{ yours: isYours, past: getOff !== undefined && position > getOff }}>
                  <span class="bus-stop-time">
                    {time - state.now.value < SOON
                      ? time <= state.now.value ? "Now" : <Minutes value={Math.max(1, Math.round((time - state.now.value) / 60))} />
                      : <Time seconds={time} />}
                  </span>
                  <StopLink stop={current.trip.stops[position]} />
                  {isYours && <span class="tag">Get off</span>}
                  {position === getOn && !isRiding.value && <span class="tag">Get on</span>}
                </li>
              )
            })}
          </ol>
          {!current.isLive && <p class="view-foot muted">From the schedule until the bus starts this trip</p>}
        </>
      )
    })}
  </>
}

/** Asks about a bus you seem to be on, atop whatever the sheet shows */
export const RideSuggestion = () =>
  r(() => {
    const id = state.suggested.value
    const routeId = id && state.vehicles.value.find(vehicle => vehicle.id === id)?.route?.id
    if (!id || !routeId || !state.feed.value.routesById.has(routeId))
      return
    const busRoute = route(routeId)
    return (
      <div class="ride-suggestion" role="status">
        <RouteBadge route={busRoute} />
        <span>On the {busRoute.long}?</span>
        <button type="button" class="button" onclick={() => { state.ride(id); capture("bus_boarded", { suggested: true }) }}>Yes</button>
        <button type="button" class="button" onclick={() => state.decline(id)}>No</button>
      </div>
    )
  })
