/** @jsxImportSource bruh/browser */

// The ways to get there by bus, and walking the whole way, and for a visit, where to park for it instead

import { r } from "bruh/reactive"
import { lateness, slack } from "../../transit/models/forecast.mts"
import { type Itinerary, type Leg, type RideLeg, wayKey } from "../../routing/plan.mts"
import { ClockRange, Counted, Distance, List, Minutes } from "../../shell/intl.tsx"
import { Icon } from "../../shell/ui.tsx"
import { RouteBadge, StopLink, Time, minutes, route } from "./common.tsx"
import { state } from "../state/map.mts"
import { capture } from "../../shell/usage.tsx"
import { Remind } from "./Remind.tsx"
import { parkingFor } from "./Parking.tsx"
import { LinkLine } from "./Pages.tsx"
import { othersOf } from "../state/ways.mts"
import { clockOf } from "../../shared/time.mts"

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
              Toward {run.trip.headsign} · <Counted value={stops} one="stop" other="stops" /> ·{" "}
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

/** When to leave: how soon, or with a time to get there by, when, and when it gets there */
const Leave = ({ itinerary: { start, end } }: { itinerary: Itinerary }) =>
  r(() => {
    const wait = start - state.now.value
    return (
      state.by.value !== undefined ? <>Leave at <Time seconds={start} /> · arrives <Time seconds={end} /></> :
      wait < 60                    ? "Leave now" :
      wait < 3600                  ? <>Leave in <Minutes value={minutes(wait)} /></> :
                                     <>Leave at <Time seconds={start} /></>
    )
  })

/** The times and legs of a departure, and when to leave for it */
const Summary = ({ itinerary: it }: { itinerary: Itinerary }) =>
  <>
    <span class="itinerary-times">
      <strong><ClockRange from={new Date(it.start * 1000)} to={new Date(it.end * 1000)} /></strong>
      <span class="duration"><Minutes value={minutesBetween(it.start, it.end)} /></span>
    </span>
    <span class="itinerary-legs">
      {shownLegs(it).map(leg => <LegChip leg={leg} />)}
      <span class="leave"><Leave itinerary={it} /></span>
    </span>
  </>

/** Chooses a departure, by the way it goes rather than by object, as a replan's fresher copy of it is still the one chosen */
const choose = (it: Itinerary) => {
  state.selected.value = wayKey(it)
  capture("itinerary_chosen", { rides: it.legs.filter(leg => leg.kind === "ride").length })
}

/**
 * A way there, at its best departure, or the one of its departures chosen, and its other departures in a line under
 * it, each a tap from being the one chosen, its steps and reminder with it
 */
const WayCard = ({ departures }: { departures: Itinerary[] }) => {
  const keys = departures.map(wayKey)
  const chosen = r(() => {
    const current = state.itinerary.value
    return current && departures[keys.indexOf(wayKey(current))]
  })
  const isSelected = r(() => chosen.value !== undefined)
  const shown = r(() => chosen.value ?? departures[0])

  const summary: HTMLButtonElement =
    <button
      type="button"
      class="itinerary-summary"
      aria-expanded={r(() => isSelected.value ? "true" : "false")}
      onclick={() => choose(shown.peek())}
    >
      {r(() => <Summary itinerary={shown.value} />)}
    </button>

  return (
    <li class={{ itinerary: true, selected: isSelected }}>
      {summary}
      {departures.length > 1 &&
        <div class="also" role="group" aria-label="Other departures">
          Also{" "}
          {r(() => <List type="unit" items={othersOf(departures, shown.value).map(other =>
            <button
              type="button"
              class="also-time"
              // An accessible name is text, never elements, so its time is formatted here
              aria-label={`Leave at ${clockOf(other.start * 1000)}`}
              onclick={() => {
                choose(other)
                // The button tapped is now the card's own departure, so focus goes there
                summary.focus()
              }}
            >
              <Time seconds={other.start} />
            </button>
          )} />)}
        </div>
      }
      {r(() => isSelected.value && <Steps itinerary={shown.value} />)}
      {r(() => isSelected.value && <Remind itinerary={shown.value} />)}
    </li>
  )
}

/**
 * Walking the whole way, and once chosen, a reminder for it: leaving now, or so as to be there by the time asked.
 * Before the buses where it feels better than the best of them, else after
 */
const WalkOption = ({ first }: { first: boolean }) =>
  r(() => {
    const option = state.walk.value
    const isSelected = r(() => state.selected.value === "walk")
    return option && option.isFirst === first &&
      <>
        <button
          type="button"
          class={{ "walk-option": true, selected: isSelected }}
          onclick={() => {
            state.selected.value = "walk"
            capture("itinerary_chosen", { rides: 0 })
          }}
        >
          <Icon name="walk" />
          {state.itineraries.value.length ? "Or walk" : "Walk"} <Minutes value={option.minutes} /> · <Distance meters={option.meters} />
          {r(() => state.by.value !== undefined && state.itinerary.value && isSelected.value && <> · leave <Time seconds={state.itinerary.value.start} /></>)}
        </button>
        {r(() => isSelected.value && state.itinerary.value && <Remind itinerary={state.itinerary.value} />)}
      </>
  })

export const Itineraries = () =>
  <section class="itineraries" aria-live="polite">
    {r(() => !state.makesIt.value && state.itineraries.value.length > 0 &&
      <p class="muted notice">Nothing gets there by <Time seconds={state.by.value!} /> · soonest first</p>
    )}
    <WalkOption first={true} />
    {r(() =>
      state.ways.value.length
        ? <ul>
            {state.ways.value.map(departures => <WayCard departures={departures} />)}
          </ul>
        : <p class="muted">No bus gets there in the next few hours.</p>
    )}
    <WalkOption first={false} />
    {r(() => state.visiting.value && <div class="lines"><LinkLine to={parkingFor(state.visiting.value)}>Parking</LinkLine></div>)}
  </section>
