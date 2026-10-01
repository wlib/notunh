/** @jsxImportSource bruh/browser */

// Formatting with bruh's Intl elements, in the reader's languages and on Durham's clock

import "bruh/components/intl/date-time"
import "bruh/components/intl/number"
import "bruh/components/intl/plural"
import "bruh/components/intl/list"
import type { BruhChild } from "bruh/browser"
import { TIME_ZONE } from "./time.mts"

/** Like "2:35 PM" */
export const ClockTime = ({ at }: { at: Date }) =>
  <bruh-date-time date={at.toISOString()} time-zone={TIME_ZONE} hour="numeric" minute="2-digit" />

/** Like "2:35 – 2:50 PM", sharing what the two times have in common */
export const ClockRange = ({ from, to }: { from: Date, to: Date }) =>
  <bruh-date-time date={from.toISOString()} end-date={to.toISOString()} time-zone={TIME_ZONE} hour="numeric" minute="2-digit" />

/** Like "Thu 4:17 AM", for when something last happened */
export const DayTime = ({ at }: { at: Date }) =>
  <bruh-date-time date={at.toISOString()} time-zone={TIME_ZONE} weekday="short" hour="numeric" minute="2-digit" />

/** A calendar day's parts, like weekday="short" for "Thu"; days are dates at noon UTC, so the zone can't shift them */
export const Day = ({ date, ...parts }: { date: string } & Pick<Intl.DateTimeFormatOptions, "weekday" | "month" | "day">) =>
  <bruh-date-time date={`${date}T12:00:00Z`} time-zone="UTC" {...parts} />

/** Like "5 min" or "640 mg" */
export const Quantity = ({ value, unit, digits = 0 }: { value: number, unit: string, digits?: number }) =>
  // Milligram isn't one of the units Intl formats, so it's spelled out beside the number
  unit === "milligram"
    ? <><bruh-number number={`${value}`} maximum-fraction-digits={`${digits}`} /> mg</>
    : <bruh-number number={`${value}`} format-style="unit" unit={unit} unit-display="short" maximum-fraction-digits={`${digits}`} />

export const Minutes = ({ value }: { value: number }) =>
  <Quantity value={value} unit="minute" />

/** Meters to the nearest 10, or kilometers past one */
export const Distance = ({ meters }: { meters: number }) =>
  meters < 1000
    ? <Quantity value={Math.round(meters / 10) * 10} unit="meter" />
    : <Quantity value={meters / 1000} unit="kilometer" digits={1} />

export const Count = ({ value }: { value: number }) =>
  <bruh-number number={`${value}`} />

// bruh 2.0.0-beta.5's watch(…, { skipFirst: true }) runs its first time a microtask late and skips that run,
// so a change made in the same tick it starts in, like these elements' own setup, is lost.
// Giving them their values a microtask later gets through; drop this once bruh's watch is fixed
const later = <E extends Element,>(element: E, f: (element: E) => void) => {
  queueMicrotask(() => f(element))
  return element
}

/** The words that go with a count, like "1 bus" and "2 buses" */
export const Plural = ({ value, one, other }: { value: number, one: BruhChild, other: BruhChild }) =>
  later(
    <bruh-plural>
      <span slot="one">{one}</span>
      <span slot="other">{other}</span>
    </bruh-plural> as HTMLElement,
    plural => plural.setAttribute("number", `${value}`)
  )

/** Items joined as a list, like "Milk, Soy, and Wheat"; "unit" leaves out the "and" */
export const List = ({ items, type = "conjunction" }: { items: BruhChild[], type?: Intl.ListFormatOptions["type"] }) =>
  later(
    <bruh-list type={type} format-style={type === "unit" ? "short" : "long"} /> as HTMLElement,
    list => list.append(...items.map(item => <span>{item}</span>))
  )

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" })

/** Like "now", "12s ago", or "3 min. ago"; bruh has no relative time element, so this is plain Intl */
export const ago = (seconds: number) =>
  seconds < 10 ? relative.format(0, "second") :
  seconds < 60 ? relative.format(-Math.round(seconds), "second") :
                 relative.format(-Math.round(seconds / 60), "minute")

/** Like "Today" or "Tomorrow", for days that have a name relative to today */
export const relativeDay = (days: number) => {
  const text = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(days, "day")
  return text[0].toLocaleUpperCase() + text.slice(1)
}
