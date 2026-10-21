/** @jsxImportSource bruh/browser */

// The ways to get there by bus, and walking the whole way

import { r } from "bruh/reactive"
import { lateness, slack } from "../../transit/models/forecast.mts"
import { type Itinerary, type Leg, type RideLeg, wayKey } from "../../routing/plan.mts"
import { ClockRange, Distance, Minutes, Plural } from "../../shell/intl.tsx"
import { Icon } from "../../shell/ui.tsx"
import { RouteBadge, StopLink, Time, minutes, route } from "./common.tsx"
import { state } from "../state/map.mts"
import { capture } from "../../shell/usage.tsx"
import { Remind } from "./Remind.tsx"

/** Minutes between two times as displayed, so durations agree with the clock times beside them */
const minutesBetween = (start: number, end: number) =>
  Math.max(1, Math.floor(end / 60) - Math.floor(start / 60))

/** Legs worth mentioning, skipping walks across the street */
const shownLegs = (itinerary: Itinerary) =>
  itinerary.legs.filter(leg => leg.kind === "ride" || leg.meters > 30)

const LegChip = ({ leg }: { leg: Leg }) =>
  leg.kind === "walk"
    ? <span class="walk-chip"><Icon name="walk" /><Minutes value={minutes(leg.end - leg.start)} /></span>
    : <RouteBadge route={route(leg.run.trip.route)} />

const Delay = ({ seconds }: { seconds: number }) => {
  const late = Math.round(seconds / 60)
  return (
    late > 0 ? <><Minutes value={late} /> late</> :
    late < 0 ? <><Minutes value={-late} /> early</> :
               "on time"
  )
}

/**
 * What to know about a boarding: that the bus waits there a minute or more, as for its scheduled time, when to be at
 * the stop for the first ride, or how long there is to change buses
 */
const Boarding = ({ itinerary, leg }: { itinerary: Itinerary, leg: RideLeg }) => {
  const { run, fromPosition, start } = leg
  if (run.departures[fromPosition] - run.arrivals[fromPosition] >= 60)
    return <>Waits here until <Time seconds={start} /></>
  const previous = itinerary.legs.slice(0, itinerary.legs.indexOf(leg)).findLast(leg => leg.kind === "ride")
  return previous
    ? <><Minutes value={minutes(start - previous.end)} /> to change</>
    : <>Be there by <Time seconds={start - slack(run, fromPosition, start, state.now.peek())} /></>
}

const Steps = ({ itinerary }: { itinerary: Itinerary }) =>
  <ol class="steps">
    {shownLegs(itinerary).map(leg => {
      if (leg.kind === "walk")
        return (
          <li class="step">
            <Icon name="walk" />
            <span>
              Walk <Minutes value={minutes(leg.end - leg.start)} /> (<Distance meters={leg.meters} />) to {leg.to.name}
            </span>
          </li>
        )

      const { run, fromPosition, toPosition } = leg
      const stops = toPosition - fromPosition
      return (
        <li class="step ride" style={`--route-color: ${route(run.trip.route).color}`}>
          <RouteBadge route={route(run.trip.route)} />
          <div>
            <div>
              <strong><Time seconds={leg.start} /></strong> Board at <StopLink stop={run.trip.stops[fromPosition]} />
            </div>
            <div class="muted">
              Toward {run.trip.headsign} · <Plural value={stops} one="1 stop" other={`${stops} stops`} /> ·{" "}
              {run.isLive
                ? <span class="live">Live, <Delay seconds={lateness(run, fromPosition)} /></span>
                : "Scheduled"}
              {" · "}<Boarding itinerary={itinerary} leg={leg} />
            </div>
            <div>
              <strong><Time seconds={leg.end} /></strong> Get off at <StopLink stop={run.trip.stops[toPosition]} />
            </div>
          </div>
        </li>
      )
    })}
  </ol>

const Leave = ({ start }: { start: number }) =>
  r(() => {
    const wait = start - state.now.value
    return (
      wait < 60   ? "Leave now" :
      wait < 3600 ? <>Leave in <Minutes value={minutes(wait)} /></> :
                    <>Leave at <Time seconds={start} /></>
    )
  })

const ItineraryCard = ({ itinerary: it }: { itinerary: Itinerary }) => {
  // By the way it goes rather than by object, as a replan's fresher copy of the chosen itinerary is still the chosen one
  const key = wayKey(it)
  const isSelected = r(() => state.itinerary.value !== undefined && wayKey(state.itinerary.value) === key)
  return (
    <li class={{ itinerary: true, selected: isSelected }}>
      <button
        type="button"
        class="itinerary-summary"
        aria-expanded={r(() => isSelected.value ? "true" : "false")}
        onclick={() => {
          state.selected.value = key
          capture("itinerary_chosen", { rides: it.legs.filter(leg => leg.kind === "ride").length })
        }}
      >
        <span class="itinerary-times">
          <strong><ClockRange from={new Date(it.start * 1000)} to={new Date(it.end * 1000)} /></strong>
          <span class="duration"><Minutes value={minutesBetween(it.start, it.end)} /></span>
        </span>
        <span class="itinerary-legs">
          {shownLegs(it).map(leg => <LegChip leg={leg} />)}
          <span class="leave"><Leave start={it.start} /></span>
        </span>
      </button>
      {r(() => isSelected.value && <Steps itinerary={it} />)}
      {r(() => isSelected.value && <Remind itinerary={it} />)}
    </li>
  )
}

const WalkOption = () =>
  r(() => {
    const option = state.walk.value
    return option &&
      <button
        type="button"
        class={{ "walk-option": true, selected: r(() => state.selected.value === "walk") }}
        onclick={() => {
          state.selected.value = "walk"
          capture("itinerary_chosen", { rides: 0 })
        }}
      >
        <Icon name="walk" />
        {state.itineraries.value.length ? "Or walk" : "Walk"} <Minutes value={option.minutes} /> · <Distance meters={option.meters} />
      </button>
  })

export const Itineraries = () =>
  <section class="itineraries" aria-live="polite">
    {r(() =>
      state.itineraries.value.length
        ? <ul>
            {state.itineraries.value.map(it => <ItineraryCard itinerary={it} />)}
          </ul>
        : <p class="muted">No good bus options in the next few hours.</p>
    )}
    <WalkOption />
  </section>
