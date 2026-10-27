/** @jsxImportSource bruh/browser */

// Formatting with bruh's Intl elements, in English like the words around it, and on Durham's clock

import "bruh/components/intl/date-time"
import "bruh/components/intl/number"
import "bruh/components/intl/plural"
import "bruh/components/intl/list"
import type { BruhChild } from "bruh/browser"
import { currentUrl } from "bruh/utils/browser"
import { TIME_ZONE, type Day as CalendarDay } from "../shared/time.mts"

// bruh 2.0.0-beta.5's elements read the reader's languages from the address, which it sets anew on every navigation,
// so each element on the page, hundreds in the map's week, makes a new formatter and renders again as a page opens.
// The address only reaches them when what they read of it changes; drop this once bruh compares what it reads
const LOCALE_PARAMS = ["locale", "language", "region"]
const askedOf = (url: URL) => LOCALE_PARAMS.map(param => url.searchParams.getAll(param).join(" ")).join("\n")
const reflected = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(currentUrl), "value")!
Object.defineProperty(currentUrl, "value", {
  get: reflected.get,
  set(url: URL) {
    if (askedOf(url) !== askedOf(currentUrl.peek()))
      reflected.set!.call(currentUrl, url)
  }
})

// The reader's own English first, like en-GB for its 24-hour clock, but always English. A plural or unit in another
// language would read wrong among English words: "1 stop" for 8 under Russian's rules, or "15 мин"
const ENGLISH = [...navigator.languages.filter(language => /^en\b/.test(language)), "en"]
const locales = ENGLISH.join(" ")

/** Like "2:35 PM"; times already on Durham's wall clock, like opening hours, are UTC dates in time zone "UTC" */
export const ClockTime = ({ at, timeZone = TIME_ZONE }: { at: Date, timeZone?: string }) =>
  <bruh-date-time locales={locales} date={at.toISOString()} time-zone={timeZone} hour="numeric" minute="2-digit" />

/** Like "2:35 – 2:50 PM", sharing what the two times have in common */
export const ClockRange = ({ from, to, timeZone = TIME_ZONE }: { from: Date, to: Date, timeZone?: string }) =>
  <bruh-date-time locales={locales} date={from.toISOString()} end-date={to.toISOString()} time-zone={timeZone} hour="numeric" minute="2-digit" />

/** Like "7 AM", or "7:30 AM" off the hour, as a rule's times read */
export const Hour = ({ at, timeZone = TIME_ZONE }: { at: Date, timeZone?: string }) =>
  <bruh-date-time locales={locales} date={at.toISOString()} time-zone={timeZone} hour="numeric" minute={at.getUTCMinutes() ? "2-digit" : undefined} />

/** Like "7 AM – 6 PM", or "7:30 – 9 AM" off the hour, as a rule's hours read: minutes of a day on Durham's wall clock */
export const HourRange = ({ start, end }: { start: number, end: number }) =>
  <bruh-date-time locales={locales} date={new Date(start * 60_000).toISOString()} end-date={new Date(end * 60_000).toISOString()} time-zone="UTC" hour="numeric" minute={start % 60 || end % 60 ? "2-digit" : undefined} />

/** Like "Fri, Jan 15, 12:30 – 5:30 AM", the day said once where both ends share it, as a stay reads */
export const DayTimeRange = ({ from, to }: { from: Date, to: Date }) =>
  <bruh-date-time locales={locales} date={from.toISOString()} end-date={to.toISOString()} time-zone={TIME_ZONE} weekday="short" month="short" day="numeric" hour="numeric" minute="2-digit" />

/** Like "Dec 14 – 18", calendar days from one to another */
export const DayRange = ({ from, to }: { from: CalendarDay, to: CalendarDay }) =>
  <bruh-date-time locales={locales} date={`${from}T12:00:00Z`} end-date={`${to}T12:00:00Z`} time-zone="UTC" month="short" day="numeric" />

/** Like "Thu 4:17 AM", for when something last happened */
export const DayTime = ({ at }: { at: Date }) =>
  <bruh-date-time locales={locales} date={at.toISOString()} time-zone={TIME_ZONE} weekday="short" hour="numeric" minute="2-digit" />

/** A calendar day's parts, like weekday="short" for "Thu"; days are dates at noon UTC, so the zone can't shift them */
export const Day = ({ of, ...parts }: { of: CalendarDay } & Pick<Intl.DateTimeFormatOptions, "weekday" | "month" | "day">) =>
  <bruh-date-time locales={locales} date={`${of}T12:00:00Z`} time-zone="UTC" {...parts} />

/** Like "5 min" or "640 mg" */
export const Quantity = ({ value, unit, digits = 0 }: { value: number, unit: string, digits?: number }) =>
  // Milligram isn't one of the units Intl formats, so it's spelled out beside the number
  unit === "milligram"
    ? <><bruh-number locales={locales} number={`${value}`} maximum-fraction-digits={`${digits}`} /> mg</>
    : <bruh-number locales={locales} number={`${value}`} format-style="unit" unit={unit} unit-display="short" maximum-fraction-digits={`${digits}`} />

/** Dollars and cents, like "$1.85" */
export const Money = ({ value }: { value: number }) =>
  <bruh-number locales={locales} number={`${value}`} format-style="currency" currency="USD" />

export const Minutes = ({ value }: { value: number }) =>
  <Quantity value={value} unit="minute" />

/** Meters to the nearest 10, or kilometers past one */
export const Distance = ({ meters }: { meters: number }) =>
  meters < 1000
    ? <Quantity value={Math.round(meters / 10) * 10} unit="meter" />
    : <Quantity value={meters / 1000} unit="kilometer" digits={1} />

export const Count = ({ value }: { value: number }) =>
  <bruh-number locales={locales} number={`${value}`} />

// bruh 2.0.0-beta.5's watch(…, { skipFirst: true }) runs its first time a microtask late and skips that run, so a
// change made in the same tick it starts in, like these elements' own setup, is lost. Setting their values a
// microtask later gets through; drop this once bruh's watch is fixed
const later = <E extends Element,>(element: E, f: (element: E) => void) => {
  queueMicrotask(() => f(element))
  return element
}

/** The words that go with a count, like "1 bus" and "2 buses" */
const Plural = ({ value, one, other }: { value: number, one: BruhChild, other: BruhChild }) =>
  later(
    <bruh-plural locales={locales}>
      <span slot="one">{one}</span>
      <span slot="other">{other}</span>
    </bruh-plural> as HTMLElement,
    plural => plural.setAttribute("number", `${value}`)
  )

/** A count and what's counted, like "1 course" and "12 courses" */
export const Counted = ({ value, one, other }: { value: number, one: string, other: string }) =>
  <Plural value={value} one={<><Count value={value} /> {one}</>} other={<><Count value={value} /> {other}</>} />

/**
 * Items joined as a list, like "Milk, Soy, and Wheat"; "unit" leaves out the "and", "CS 450, CS 518, IT 791", and
 * narrow too the commas, "Tue Thu"
 */
export const List = ({ items, type = "conjunction", style = type === "unit" ? "short" : "long" }: { items: BruhChild[], type?: Intl.ListFormatOptions["type"], style?: Intl.ListFormatOptions["style"] }) =>
  later(
    <bruh-list locales={locales} type={type} format-style={style} /> as HTMLElement,
    list => list.append(...items.map(item => <span>{item}</span>))
  )

/** Days of the week, 0 for Monday, by their short names: "Sat, Sun", or narrow, as a class's pattern reads, "Tue Thu" */
export const Weekdays = ({ days, style = "short" }: { days: readonly number[], style?: "short" | "narrow" }) =>
  // 1 January 2024 was a Monday, as day 0 is
  <List type="unit" style={style} items={days.map(day => <Day of={`2024-01-${String(day + 1).padStart(2, "0")}`} weekday="short" />)} />

// A select's options hold only text, never an element, so durations there are formatted by plain Intl, as Minutes
// and Quantity's elements would say them
const minuteFormat = new Intl.NumberFormat(ENGLISH, { style: "unit", unit: "minute", unitDisplay: "short" })
const hourFormat = new Intl.NumberFormat(ENGLISH, { style: "unit", unit: "hour", unitDisplay: "short" })

/** Like "30 min", for an option */
export const minutesText = (minutes: number) =>
  minuteFormat.format(minutes)

/** Like "2 hr", for an option */
export const hoursText = (hours: number) =>
  hourFormat.format(hours)

// bruh has no relative time element, so these are plain Intl
const relative = new Intl.RelativeTimeFormat(ENGLISH, { numeric: "auto", style: "narrow" })
const relativeDays = new Intl.RelativeTimeFormat(ENGLISH, { numeric: "auto" })

/** Like "now", "12s ago", or "3 min. ago" */
export const ago = (seconds: number) =>
  seconds < 10 ? relative.format(0, "second") :
  seconds < 60 ? relative.format(-Math.round(seconds), "second") :
                 relative.format(-Math.round(seconds / 60), "minute")

/** Like "Today" or "Tomorrow", for days that have a name relative to today */
export const relativeDay = (days: number) => {
  const text = relativeDays.format(days, "day")
  return text[0].toLocaleUpperCase() + text.slice(1)
}
