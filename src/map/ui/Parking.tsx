/** @jsxImportSource bruh/browser */

// Parking for a stay (src/parking/model.mts): the sheet of areas near a place, ranked by whether the whole stay fits,
// then by the walk, each a verdict in words with its reason and a thin bar of the stay; an area's page, with its
// verdict, what it depends on, and its rules in the order they bite; your permit, chosen in the sheet's fields and
// synced with your other things; and search's parking. Ranked, never chosen, and never tinted on the map. What's said
// is read from UNH's posted rules, checked nightly against what a machine can read, and is never an official answer:
// where the rules can't be known for sure, as on a winter night, it says so and links to UNH's page, and the town's
// lots are the town's page

import type { BruhChild } from "bruh/browser"
import { type DerivativeNode, r } from "bruh/reactive"
import { type Answer, type Area, type Kind, type Permit, type Purpose, type Segment, type Stay, type Verdict, type Who, EVERY_DAY, PARKMOBILE_APP, WEEKDAYS, fits, nextChange, options } from "../../parking/model.mts"
import { type ParkingData, TOWN_PAGE, WINTER_PAGE, checkedAt } from "../../parking/sources.mts"
import { type Page, type Parking, fieldOf, fromField } from "../state/page.mts"
import { defaultStay, purposeOfVisit, readPermit, stayOfVisit } from "../state/parking.mts"
import { state } from "../state/map.mts"
import type { Visit } from "../../shared/visit.mts"
import { localDay } from "../../shared/time.mts"
import { Counted, Day, DayTimeRange, Hour, HourRange, List, Minutes, Money, Quantity, Weekdays } from "../../shell/intl.tsx"
import { minutes } from "./common.tsx"
import { Group } from "./Courses.tsx"
import { Go, Head, Line, Row, placeNamed, share } from "./Pages.tsx"

type ParkingPage = Extract<Page, { kind: "parking" }>
type AreaPage = Extract<Page, { kind: "area" }>

/** How many areas the sheet ranks: the best few, as the rest are further or don't fit */
const TOP = 5

const FITS = { yes: "Fits", no: "No", unknown: "Maybe" }
const HEADLINE = { yes: "Fits", no: "Doesn't fit", unknown: "Winter ban may apply" }
const PURPOSES: Record<Purpose, string> = { class: "A class", event: "An event", errand: "An errand", visit: "A visit" }
const PERMITS: Record<Extract<Permit, string>, string> = { "commuter": "Commuter", "faculty": "Faculty/staff", "resident-west": "Resident, west", "non-resident": "Non-resident" }

/** Epoch ms now, not followed: a stay asked for is from the minute it was asked */
const nowMs = () => state.now.peek() * 1000

const lower = (text: string) =>
  text[0].toLocaleLowerCase() + text.slice(1)

/** Who's parking, by the permit kept here and what it's for */
const whoOf = (purpose?: Purpose): Who =>
  ({ permit: state.permit.value, purpose })

/** When in a stay something happens, "7 AM", with its day where that isn't the arrival's: "Mon 7 AM" */
const At = ({ at, stay }: { at: number, stay: Stay }) =>
  <>{localDay(at) !== localDay(stay.from) && <><Day of={localDay(at)} weekday="short" /> </>}<Hour at={new Date(at)} /></>

/** A verdict's reason, its rate or limit where it has one, and from when, where that's after the arrival: "Pay $1.85/h from 7 AM" */
const Reason = ({ answer, stay }: { answer: Answer, stay: Stay }) =>
  <>
    {answer.rate !== undefined ? <>Pay <Money value={answer.rate} />/h</> :
     answer.limit !== undefined ? <>Over the <Quantity value={answer.limit} unit="hour" /> limit</> :
                                  answer.why}
    {answer.from > stay.from && <> from <At at={answer.from} stay={stay} /></>}
  </>

/** What an area becomes next, in a few words */
const becomes = (area: Area, next: Segment) =>
  next.kind === "closed" ? lower(next.why) :
  next.kind === "free"   ? (area.zone ? "free" : "open") :
  ({ pay: "pay", permit: "your permit", unknown: "winter ban may apply" } satisfies Record<Exclude<Kind, "closed" | "free">, string>)[next.kind]

/**
 * What changes next: where a stay is refused by the clock, when it opens again, "open from 6 PM"; where it fits, what
 * comes after it, "then permit required from 7 AM", where isAfter asks. Nothing where it's refused for another
 * reason, like its purpose
 */
const NextChange = ({ area, verdict, stay, who, isAfter }: { area: Area, verdict: Verdict, stay: Stay, who: Who, isAfter?: boolean }) => {
  const isTimed = verdict.segments.some(segment => segment.kind === "closed" && segment.from === verdict.from)
  if (verdict.fits === "unknown" || (verdict.fits === "no" && !isTimed) || (verdict.fits === "yes" && !isAfter))
    return null
  const next = nextChange(area, who, verdict.fits === "no" ? verdict.from : verdict.segments.at(-1)!.from, state.holidays.peek())
  return next && <> · {verdict.fits === "yes" && "then "}{becomes(area, next)} from <At at={next.from} stay={stay} /></>
}

/** The stay as a thin bar, a run for each state, as long as it lasts */
const Bar = ({ segments }: { segments: readonly Segment[] }) =>
  <span class="stay-bar" aria-hidden="true">
    {segments.map(segment => <span class={segment.kind} style={`flex-grow: ${(segment.to - segment.from) / 60_000}`} />)}
  </span>

/** A permit as a select's value: "" for none, the kind, or "resident:E" for a resident lot's */
const permitValue = (permit?: Permit) =>
  permit === undefined ? "" : typeof permit === "string" ? permit : `resident:${permit.resident}`

const permitOf = (value: string): Permit | undefined =>
  value.startsWith("resident:") ? { resident: value.slice("resident:".length) } : readPermit(value)

/** The resident permits the areas take, each by the name of its lot */
const residentLots = (areas: readonly Area[]) =>
  new Map(areas.flatMap(area => area.permits.flatMap(permit => typeof permit === "object" ? [[permit.resident, area.name] as const] : [])))

/** A permit in words: "faculty/staff", or "E Lot resident" */
const permitName = (permit: Permit, areas: readonly Area[]) =>
  typeof permit === "string" ? PERMITS[permit].toLocaleLowerCase() : `${residentLots(areas).get(permit.resident) ?? permit.resident} resident`

/** Your permit, as the sheet's fields choose it */
const PermitSelect = ({ label }: { label: string }) =>
  r(() => {
    const current = permitValue(state.permit.value)
    const residents = residentLots(state.parking.value.areas)
    const permit = state.permit.peek()
    if (typeof permit === "object" && !residents.has(permit.resident))
      residents.set(permit.resident, permit.resident)
    const select: HTMLSelectElement =
      <select aria-label={label} onchange={() => state.permit.value = permitOf(select.value)}>
        <option value="" selected={current === ""}>None</option>
        {Object.entries(PERMITS).map(([value, name]) => <option value={value} selected={current === value}>{name}</option>)}
        <optgroup label="Resident of">
          {[...residents].map(([id, name]) => <option value={`resident:${id}`} selected={current === `resident:${id}`}>{name}</option>)}
        </optgroup>
      </select>
    return select
  })

/** What kind of area, its zone and its spaces where known: "Faculty/staff lot · 573 spaces", "Meters · zone 98714", "Resident lot" */
export const kindOf = (area: Area) => {
  const [only, ...more] = area.permits
  const kind =
    !area.permits.length                                     ? (area.zone ? "Meters" : "Parking") :
    area.permits.every(permit => typeof permit === "object") ? "Resident lot" :
    !more.length && typeof only === "string"                 ? `${PERMITS[only]} lot` :
                                                               "Permit lot"
  // A zone's number is a code on a sign, never grouped like a count
  return <>{kind}{area.zone && ` · zone ${area.zone.number}`}{area.spaces && <> · <Counted value={area.spaces} one="space" other="spaces" /></>}</>
}

/** Where the rules are from and how fresh, which is never official */
const Checked = ({ data, extra }: { data: ParkingData, extra?: BruhChild }) =>
  <p class="view-foot muted">UNH Transportation's rules, checked <Day of={localDay(checkedAt(data))} month="short" day="numeric" /> · unofficial{extra}</p>

/** UNH's winter rules, for a stay this can't answer */
const WinterRules = () =>
  <a class="go" href={WINTER_PAGE} target="_blank" rel="noopener">UNH's winter rules ›</a>

const Missing = () =>
  <p class="muted">Parking couldn't load. Try again once online.</p>

/** The four fields a stay is asked for by: arrive, leave, your permit, and what for */
const Fields = ({ stay, purpose, set }: { stay: DerivativeNode<Stay>, purpose: DerivativeNode<Purpose>, set: (change: Parking) => void }) => {
  const arrive: HTMLInputElement =
    <input
      type="datetime-local"
      aria-label="Arrive"
      value={fieldOf(stay.peek().from)}
      onchange={() => {
        const { from, to } = stay.peek()
        const at = fromField(arrive.value)
        if (at === undefined)
          return void (arrive.value = fieldOf(from))
        // The stay keeps its length, as arriving later most often means leaving later
        set({ stay: { from: at, to: at + to - from } })
        leave.value = fieldOf(at + to - from)
      }}
    />
  const leave: HTMLInputElement =
    <input
      type="datetime-local"
      aria-label="Leave"
      value={fieldOf(stay.peek().to)}
      onchange={() => {
        const { from, to } = stay.peek()
        const at = fromField(leave.value)
        if (at === undefined || at <= from)
          return void (leave.value = fieldOf(to))
        set({ stay: { from, to: at } })
      }}
    />
  const purposes: HTMLSelectElement =
    <select aria-label="For" onchange={() => set({ purpose: purposes.value as Purpose })}>
      {Object.entries(PURPOSES).map(([value, name]) => <option value={value} selected={value === purpose.peek()}>{name}</option>)}
    </select>
  // A line saying what's asked, which opens to change it, so the areas ranked lead the sheet
  return (
    <details class="parking-ask">
      <summary>
        <span class="parking-asked">
          {r(() => <DayTimeRange from={new Date(stay.value.from)} to={new Date(stay.value.to)} />)}
          <span class="muted">{r(() => <>{state.permit.value ? permitName(state.permit.value, state.parking.value.areas) : "no permit"} · {PURPOSES[purpose.value].toLocaleLowerCase()}</>)}</span>
        </span>
        <span class="go">Change</span>
      </summary>
      <div class="parking-fields">
        <div class="parking-stay">
          <label class="field"><span>Arrive</span>{arrive}</label>
          <label class="field"><span>Leave</span>{leave}</label>
        </div>
        <label class="field"><span>Permit</span><PermitSelect label="Permit" /></label>
        <label class="field"><span>For</span>{purposes}</label>
      </div>
    </details>
  )
}

/** An area ranked for a stay: its name, the stay as a bar, the verdict in words, the cost and the walk, and whether it fits */
const OptionRow = ({ option, stay, purpose }: { option: ReturnType<typeof options>[number], stay: Stay, purpose: Purpose }) =>
  <Row
    what={option.area.name}
    sub={<>
      <Bar segments={option.segments} />
      <span>
        <Reason answer={option} stay={stay} />
        <NextChange area={option.area} verdict={option} stay={stay} who={whoOf(purpose)} />
        {option.cost > 0 && <> · <Money value={option.cost} /></>}
        {option.walk && <> · <Minutes value={minutes(option.walk.seconds)} /> walk{option.walk.approx && ", approx."}</>}
      </span>
    </>}
    standing={<span class={`fits-${option.fits}`}>{FITS[option.fits]}</span>}
    onclick={() => state.go({ kind: "area", id: option.area.id, stay, purpose })}
  />

/** Parking near a place for a stay: its four fields, and the areas ranked for it, the best few, and the nearest that doesn't fit, where it's nearer than those */
export const ParkingView = ({ page }: { page: ParkingPage }) => {
  const fallback = defaultStay(nowMs())
  const asked = r(() => {
    const shown = state.page.value
    return shown?.kind === "parking" ? shown : page
  })
  const stay = r(() => asked.value.stay ?? fallback)
  const purpose = r(() => asked.value.purpose ?? "visit")
  const set = (change: Parking) =>
    state.amend({ ...asked.peek(), stay: stay.peek(), purpose: purpose.peek(), ...change })
  const place = placeNamed(page.place)
  state.focusAt(page, place && { place, label: place.name })
  return (
    <>
      <Head title={page.place ? `Parking near ${page.place}` : "Parking"} name="Parking" />
      <Fields stay={stay} purpose={purpose} set={set} />
      {r(() => {
        const data = state.parking.value
        if (!data.areas.length)
          return <Missing />
        const all = options(data.areas, whoOf(purpose.value), stay.value, state.holidays.value, place && { to: place, walks: state.walks.value })
        // The nearest area that doesn't fit, where it's nearer than some shown, so the lot a driver would try first says why not
        const shown = all.slice(0, TOP)
        const furthest = Math.max(...shown.map(option => option.walk?.meters ?? 0))
        const nearer = all.slice(TOP).filter(option => option.fits === "no" && option.walk && option.walk.meters < furthest).sort((a, b) => a.walk!.meters - b.walk!.meters)[0]
        const ranked = [...shown, ...nearer ? [nearer] : []]
        return (
          <>
            <ul class="rows parking-rows" aria-label="Parking areas">
              {ranked.map(option => <OptionRow option={option} stay={stay.value} purpose={purpose.value} />)}
            </ul>
            {ranked.some(option => option.fits === "unknown") && <p class="muted">The winter ban's lots and hours change by the night. <WinterRules /></p>}
            <Checked data={data} extra={<> · posted signs win · open spaces unknown · <a class="go" href={TOWN_PAGE} target="_blank" rel="noopener">town lots ›</a></>} />
          </>
        )
      })}
    </>
  )
}

/** Weekdays as a rule says them: "Weekdays", "Every day", or each, "Sat" */
const Days = ({ days }: { days: readonly number[] }) =>
  `${days}` === `${WEEKDAYS}`  ? <>Weekdays</> :
  `${days}` === `${EVERY_DAY}` ? <>Every day</> :
                                 <Weekdays days={days} />

/**
 * An area's rules as lines, in the order they bite: the hours its permits are checked, its paid hours, the hours
 * it's open or free otherwise, the winter ban, as far as it's certain, and the areas within it with rules of their
 * own, like a lot's meter spaces
 */
const Rules = ({ data, area, page }: { data: ParkingData, area: Area, page: AreaPage }) => {
  const names = area.permits.map(permit => permitName(permit, data.areas))
  const within = data.areas.filter(other => other !== area && (other.id.startsWith(`${area.id}-`) || area.id.startsWith(`${other.id}-`)))
  return (
    <div class="lines">
      {names.length > 0 &&
        <Line label={area.always ? "Around the clock" : <>Weekdays <HourRange start={7 * 60} end={18 * 60} /></>}><span><List items={names} /> permit</span></Line>}
      {area.zone?.paid.map(paid =>
        <Line label={<><Days days={paid.days} /> <HourRange start={paid.hours[0]} end={paid.hours[1]} /></>}><span><Money value={paid.rate} />/h · <Quantity value={paid.max} unit="hour" /> max</span></Line>)}
      {area.zone
        ? <Line label="Other hours, UNH holidays">free</Line>
        : !area.always && names.length > 0 && <Line label="Evenings, weekends, UNH holidays">open to all</Line>}
      <Line label="Winter nights, Dec – Apr">
        <span>{area.winter === "permit-holders" ? "permit holders stay all night" : <>ban may apply, <HourRange start={0} end={7 * 60} /></>}</span>
        <WinterRules />
      </Line>
      {within.map(other =>
        <Line label={other.name}><Go to={{ ...page, id: other.id }}>{other.zone ? `Zone ${other.zone.number} ›` : "›"}</Go></Line>)}
    </div>
  )
}

/** The verdict for the stay: whether it fits, why and from when, what changes next, and what it costs, or that the winter ban may apply */
const Answered = ({ area, stay, purpose }: { area: Area, stay: Stay, purpose?: Purpose }) =>
  r(() => {
    const who = whoOf(purpose)
    const verdict = fits(area, who, stay, state.holidays.value)
    return (
      <div class={`verdict fits-${verdict.fits}`}>
        <p class="view-when">{HEADLINE[verdict.fits]}</p>
        <p class="view-facts">
          {verdict.fits === "unknown"
            ? <>From <At at={verdict.from} stay={stay} />, which notunh can't say for sure</>
            : <>
                <strong><Reason answer={verdict} stay={stay} /></strong>
                <NextChange area={area} verdict={verdict} stay={stay} who={who} isAfter />
                {verdict.cost > 0 && <> · <Money value={verdict.cost} /> for <Quantity value={verdict.pay} unit="hour" digits={1} /></>}
              </>}
        </p>
      </div>
    )
  })

/** A parking area's page: your stay, its verdict, Directions and where to pay, and its rules */
const AreaView = ({ data, area, page }: { data: ParkingData, area: Area, page: AreaPage }) => {
  const stay = page.stay ?? defaultStay(nowMs())
  state.focusAt(page, { place: { lon: area.at[0], lat: area.at[1], name: area.name }, label: area.guessed ? `${area.name}, approx.` : area.name })
  return (
    <>
      <Head kind={kindOf(area)} title={area.name} />
      <p class="view-label">Your stay · <DayTimeRange from={new Date(stay.from)} to={new Date(stay.to)} /></p>
      <Answered area={area} stay={stay} purpose={page.purpose} />
      <div class="view-actions">
        {!area.guessed &&
          <button type="button" class="button primary" onclick={() => { void state.directTo({ lat: area.at[1], lon: area.at[0], name: area.name }); state.go() }}>Directions</button>}
        <button type="button" class="button" onclick={() => share(area.name)}>Share</button>
        {area.zone && <a class="button" href={PARKMOBILE_APP} target="_blank" rel="noopener">Pay · ParkMobile zone {area.zone.number}</a>}
      </div>
      {area.guessed && <p class="muted">Its place on the map is approx., so no route starts there.</p>}
      <Rules data={data} area={area} page={page} />
      {area.notes && !area.guessed && <p class="muted">{area.notes}</p>}
      <Checked data={data} />
    </>
  )
}

/** A parking area's page, once the areas have loaded */
export const AreaPageView = ({ page }: { page: AreaPage }) =>
  r(() => {
    const data = state.parking.value
    const area = data.areas.find(area => area.id === page.id)
    if (area)
      return <AreaView data={data} area={area} page={page} />
    return data.areas.length
      ? <><Head title={page.id} /><p class="muted">No parking area by that name.</p></>
      : <Missing />
  })

/** Parking's page for a visit: near its place, for its stay, for what it's for */
export const parkingFor = (visit: Visit): ParkingPage =>
  ({ kind: "parking", place: visit.destination.place, stay: stayOfVisit(visit), purpose: purposeOfVisit(visit) })

/** Search's parking: the sheet near where you're going, for "parking", and the areas by name, each with its kind */
export const ParkingResults = ({ query }: { query: DerivativeNode<string> }) =>
  r(() => {
    const text = query.value.trim().toLocaleLowerCase()
    const areas = state.parking.value.areas
    const named = text.length < 2 ? [] : areas.filter(area => area.name.toLocaleLowerCase().includes(text) || area.id.toLocaleLowerCase() === text)
    const isParking = text.length >= 3 && ("parking".startsWith(text) || text.includes("park"))
    if (!named.length && !isParking)
      return null
    const to = state.to.value
    const near = to && placeNamed(to.name) ? to.name : undefined
    const rows: BruhChild[] = [
      isParking && <Row what={near ? `Parking near ${near}` : "Parking"} standing="›" onclick={() => state.go({ kind: "parking", place: near })} />,
      ...named.slice(0, TOP).map(area => <Row what={area.name} sub={kindOf(area)} standing="›" onclick={() => state.go({ kind: "area", id: area.id })} />)
    ]
    return <Group label="Parking">{rows}</Group>
  })
