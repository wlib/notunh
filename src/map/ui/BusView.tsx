/** @jsxImportSource bruh/browser */

// A bus's stops still to come, with yours picked out, and saying you're on it; and asking about a bus you
// seem to be on

import { r } from "bruh/reactive"
import { runOf, timeAt } from "../plan.mts"
import { feed, now, runs, vehicles, lastUpdate, itinerary, selectedBus, riding, suggested, shownRoutes, chosenRoutes } from "../state.mts"
import { decline, ride } from "../riding.mts"
import { Minutes, ago } from "../../shell/intl.tsx"
import { Icon } from "../../shell/ui.tsx"
import { RouteBadge, StopLink, Time, route } from "./common.tsx"

// A stop the bus left this recently still shows, as it may just be pulling out
const JUST_LEFT = 30 // s
// Sooner than this, a stop shows how many minutes away it is rather than when
const SOON = 30 * 60 // s

/** Epoch milliseconds, ticking every second for "Last seen 5s ago" */
const second = r(Date.now())
setInterval(() => second.value = Date.now(), 1000)

export const BusView = ({ id }: { id: string }) => {
  const vehicle = r(() => vehicles.value.find(vehicle => vehicle.id === id))
  const isRiding = r(() => riding.value === id)
  const run = r(() => runOf(runs.value, id, now.value))

  return (
    <section class="bus-view">
      {r(() => {
        const busRoute = vehicle.value?.route && feed.routesById.get(vehicle.value.route.id)
        if (!busRoute)
          return (
            <header>
              <p class="muted">This bus stopped reporting.</p>
              {isRiding.value
                ? <button type="button" class="button" onclick={() => ride(undefined)}>I got off</button>
                : <Close />}
            </header>
          )
        const isOnlyRoute = r(() => shownRoutes.value.size === 1 && shownRoutes.value.has(busRoute.id))
        return (
          <>
            <header>
              <RouteBadge route={busRoute} />
              <div>
                <h2>{busRoute.long}</h2>
                {r(() => {
                  // Loops are often signed with the route's own name, which says nothing more
                  const toward = run.value?.trip.headsign ?? vehicle.value?.dir?.dirNameShort
                  return toward && toward !== busRoute.long && <p class="muted">Toward {toward}</p>
                })}
              </div>
              {r(() => !isRiding.value && <Close />)}
            </header>
            <p class="muted">
              {r(() =>
                isRiding.value
                  ? "You're on this bus"
                  : `Last seen ${ago((vehicle.value?.secsSinceReport ?? 0) + (second.value - (lastUpdate.value ?? second.value)) / 1000)}`
              )}
            </p>
            <div class="bus-actions">
              {r(() => isRiding.value
                ? <button type="button" class="button" onclick={() => ride(undefined)}>I got off</button>
                : <button type="button" class="button" onclick={() => { ride(id); selectedBus.value = undefined }}>I'm on this bus</button>
              )}
              <button
                type="button"
                class="button"
                onclick={() => chosenRoutes.value = isOnlyRoute.peek() ? undefined : new Set([busRoute.id])}
              >
                {r(() => isOnlyRoute.value ? "Show all routes" : "Show only this route")}
              </button>
            </div>
          </>
        )
      })}
      {r(() => {
        const current = run.value
        if (!current)
          return <p class="muted">Umo isn't saying which stops this bus has next.</p>

        // The stop an itinerary gets off this bus at, and where it gets on if you're not on yet
        const leg = itinerary.value?.legs.find(leg =>
          leg.kind === "ride" && leg.run.trip.id === current.trip.id && leg.run.base === current.base
        )
        const [getOn, getOff] = leg?.kind === "ride" ? [leg.fromPosition, leg.toPosition] : []
        const positions = current.trip.stops
          .map((_, position) => position)
          .filter(position => timeAt(current, position) >= now.value - JUST_LEFT)
        const isNext = getOff !== undefined && positions[0] === getOff && isRiding.value

        return (
          <>
            {isNext && <p class="notice cue" role="status">Your stop is next</p>}
            <ol class="bus-stops">
              {positions.map(position => {
                const time = timeAt(current, position)
                const isYours = position === getOff
                return (
                  <li class={{ yours: isYours, past: getOff !== undefined && position > getOff }}>
                    <span class="bus-stop-time">
                      {time - now.value < SOON
                        ? time <= now.value ? "Now" : <Minutes value={Math.max(1, Math.round((time - now.value) / 60))} />
                        : <Time seconds={time} />}
                    </span>
                    <StopLink stop={current.trip.stops[position]} />
                    {isYours && <span class="tag">Get off</span>}
                    {position === getOn && !isRiding.value && <span class="tag">Get on</span>}
                  </li>
                )
              })}
            </ol>
            {!current.isLive && <p class="muted legend">From the schedule until the bus starts this trip</p>}
          </>
        )
      })}
    </section>
  )
}

const Close = () =>
  <button type="button" class="close" aria-label="Close" onclick={() => selectedBus.value = undefined}>
    <Icon name="close" />
  </button>

/** Asks about a bus you seem to be on */
export const RideSuggestion = () =>
  r(() => {
    const id = suggested.value
    const routeId = id && vehicles.value.find(vehicle => vehicle.id === id)?.route?.id
    if (!id || !routeId || !feed.routesById.has(routeId))
      return
    const busRoute = route(routeId)
    return (
      <div class="ride-suggestion" role="status">
        <RouteBadge route={busRoute} />
        <span>On the {busRoute.long}?</span>
        <button type="button" class="button" onclick={() => ride(id)}>Yes</button>
        <button type="button" class="button" onclick={() => decline(id)}>No</button>
      </div>
    )
  })
