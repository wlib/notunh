/** @jsxImportSource bruh/browser */

// The ways to get there by bus, and walking the whole way

import { r } from "bruh/reactive"
import { type Itinerary, type Leg, itineraryKey } from "../plan.mts"
import { now, selected, itineraries, itinerary, walk } from "../state.mts"
import { ClockRange, Distance, Minutes, Plural } from "../../shell/intl.tsx"
import { Icon } from "../../shell/ui.tsx"
import { RouteBadge, StopLink, Time, minutes, route } from "./common.tsx"

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
                ? <span class="live">Live, <Delay seconds={run.delays[fromPosition]} /></span>
                : "Scheduled"}
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
    const wait = start - now.value
    return (
      wait < 60   ? "Leave now" :
      wait < 3600 ? <>Leave in <Minutes value={minutes(wait)} /></> :
                    <>Leave at <Time seconds={start} /></>
    )
  })

const ItineraryCard = ({ itinerary: it }: { itinerary: Itinerary }) => {
  const isSelected = r(() => itinerary.value === it)
  return (
    <li class={{ itinerary: true, selected: isSelected }}>
      <button
        type="button"
        class="itinerary-summary"
        aria-expanded={r(() => isSelected.value ? "true" : "false")}
        onclick={() => selected.value = itineraryKey(it)}
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
    </li>
  )
}

const WalkOption = () =>
  r(() => {
    const option = walk.value
    return option &&
      <button
        type="button"
        class={{ "walk-option": true, selected: r(() => selected.value === "walk") }}
        onclick={() => selected.value = "walk"}
      >
        <Icon name="walk" />
        {itineraries.value.length ? "Or walk" : "Walk"} <Minutes value={option.minutes} /> · <Distance meters={option.meters} />
      </button>
  })

export const Itineraries = () =>
  <section class="itineraries" aria-live="polite">
    {r(() =>
      itineraries.value.length
        ? <ul>
            {itineraries.value.map(it => <ItineraryCard itinerary={it} />)}
          </ul>
        : <p class="muted">No good bus options in the next few hours.</p>
    )}
    <WalkOption />
  </section>
