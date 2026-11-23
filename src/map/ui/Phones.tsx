/** @jsxImportSource bruh/browser */

// The phone numbers worth having (../phones.mts), a page of the sheet from Campus, emergency first, each a tap from
// calling; search's rows for them; and in directions, UNH Police's walking escort where no bus goes between two places
// on campus. All of it is in the app as built, so it's there offline

import { type DerivativeNode, r } from "bruh/reactive"
import { DISPATCH, type Phone, PHONES, offersEscort, phonesFor, telOf } from "../phones.mts"
import { state } from "../state/map.mts"
import { Group } from "./Courses.tsx"
import { Head, Row } from "./Pages.tsx"

/** A number as a row that calls it: its name, what it's for, and the number */
const PhoneRow = ({ phone }: { phone: Phone }) =>
  <li>
    <a class="row phone-row" href={`tel:${telOf(phone)}`}>
      <span class="row-what">
        <strong>{phone.name}</strong>
        {phone.note && <span class="muted">{phone.note}</span>}
      </span>
      <span class="phone-number">{phone.number}</span>
    </a>
  </li>

/** The numbers in the sheet, emergency first */
export const PhonesView = () => {
  state.focusAt({ kind: "phones" }, undefined)
  return <>
    <Head kind="Campus" title="Phone numbers" />
    {PHONES.map(({ heading, phones }, i) => <>
      <h2 class="eyebrow">{heading}</h2>
      <ul class={i === 0 ? "rows phones urgent" : "rows phones"}>{phones.map(phone => <PhoneRow phone={phone} />)}</ul>
      {i === 0 && <p class="view-facts muted">No shuttle running? UNH Security gives a free walking escort between on-campus locations. Call dispatch.</p>}
    </>)}
    <p class="view-foot muted">From UNH's pages. TTY: <a href="tel:711">Relay NH, 711</a>.</p>
  </>
}

/** Search's numbers for what's typed, each calling, and the page of them all */
export const PhoneResults = ({ query }: { query: DerivativeNode<string> }) =>
  r(() => {
    const { isPage, phones } = phonesFor(query.value)
    return isPage &&
      <Group label="Phone numbers">
        {phones.slice(0, 3).map(phone => <PhoneRow phone={phone} />)}
        <Row what="All phone numbers" standing="›" onclick={() => state.go({ kind: "phones" })} />
      </Group>
  })

/** Directions' word on UNH Police's walking escort, where it's offered for the trip, which calls dispatch */
export const Escort = () =>
  r(() => {
    const [from, to, walk] = [state.from.value, state.to.value, state.walk.value]
    return from && to && walk && offersEscort({ from, to, hasBus: state.ways.value.length > 0, meters: walk.meters }) &&
      <div class="escort">
        <p class="notice">No shuttle running? UNH Security gives a free walking escort between on-campus locations.</p>
        <a class="line link-line" href={`tel:${telOf(DISPATCH)}`}><span>Call for an escort · {DISPATCH.number}</span><span>›</span></a>
      </div>
  })
