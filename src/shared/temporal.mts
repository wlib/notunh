// Temporal, the one model of days, times of day and zoned moments for recurrence, sessions and calendar files
// (recur.mts, ics.mts): the engine's own where it has one, else temporal-polyfill. The Worker, the scripts and the
// tests import the polyfill as they load ("#temporal" in package.json), so nothing there need wait. A page's code
// doesn't: it's a chunk of its own that only loadTemporal fetches, so an engine with Temporal never downloads it,
// and a page awaits loadTemporal before the first thing that asks a rule, which is the courses loading
// (src/courses/browser/terms.mts) or a calendar imported (src/map/state/calendars.mts). Nothing awaits as a module
// loads, which Safari gets wrong where several modules import the one awaiting (webkit.org/b/242740). Never
// imported by the service worker

import { Temporal as polyfill } from "#temporal"
import { TIME_ZONE } from "./time.mts"

/** Temporal: in a page without its own, missing until loadTemporal has resolved */
export let Temporal = globalThis.Temporal ?? polyfill as unknown as typeof globalThis.Temporal

/** Loads Temporal where there's none yet, as a page in an engine without its own must before it asks a rule */
export const loadTemporal = async () => {
  Temporal ??= (await import("temporal-polyfill/implementation")).Temporal as unknown as typeof globalThis.Temporal
}

/** A Durham day, "YYYY-MM-DD", as the day it names */
export const plainDay = (day: string) =>
  Temporal.PlainDate.from(day)

/** The day it is in a zone at an instant, epoch ms */
export const dayAt = (ms: number, zone = TIME_ZONE) =>
  Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDate()

/**
 * Epoch ms of a time of day, "HH:MM", on a day by a zone's clock. A time the clocks skip in spring is read an hour
 * later, and one they repeat in autumn is its first, as calendars do
 */
export const instantAt = (day: Temporal.PlainDate, time: string, zone = TIME_ZONE) =>
  day.toZonedDateTime({ timeZone: zone, plainTime: Temporal.PlainTime.from(time) }).epochMilliseconds
