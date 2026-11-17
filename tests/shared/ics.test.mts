import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import { type Read, plansOf, readEvents, ruleOfRRule, utc, writeCalendar } from "../../src/shared/ics.mts"
import { any, between, boundsOf, every, except, occurrences, on, spansOf, weekly } from "../../src/shared/recur.mts"
import { Temporal, dayAt, instantAt, plainDay } from "../../src/shared/temporal.mts"
import { HOUR, TIME_ZONE, hhmm } from "../../src/shared/time.mts"
import { clock, day, dayAndRule, simple, weekday } from "./rules.mts"

const fixture = (name: string) =>
  readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8")

/** Each event's days among some, as text, with the event */
const daysOf = (events: readonly Read[], from: Temporal.PlainDate, days: number) =>
  events.flatMap(event => occurrences(event.session.rule, from, days).map(one => ({ day: one.toString(), event })))

/** An event's days as "YYYY-MM-DD HH:MM" on Durham's clock, whatever zone it's in */
const told = (event: Read, from: string, days: number) =>
  spansOf(event.session, plainDay(from), days, event.zone).map(({ start }) => `${dayAt(start)} ${hhmm(start)}`)

//#region Rules to a file and back

test("a rule with a first and a last day, written to a file and read back, falls on the same days, each told once, at the same times", () =>
  fc.assert(fc.property(dayAndRule, fc.integer({ min: 0, max: 300 }), clock, clock, fc.integer({ min: 1, max: 2 }), ({ base, rule: within }, length, start, end, through) => {
    const rule = between(base.subtract({ days: 100 }).toString(), base.add({ days: length }).toString(), within)
    // One that ends before it starts ends on a later day
    const nights = end < start || through > 1 ? through : undefined
    const session = { rule, start, end, ...nights && { nights } }
    const events = readEvents(writeCalendar("Test", [{ uid: "one@notunh.app", title: "One", session }], instantAt(base, "12:00")))
    // A rule that never falls has a first day after its last
    const bounds = boundsOf(rule)
    const from = plainDay(bounds.from!)
    const days = Math.max(from.until(plainDay(bounds.until!)).days + 1, 0)
    expect(daysOf(events, from, days).map(({ day }) => day).sort()).toEqual(occurrences(rule, from, days).map(String))
    // Nothing before its first day or after its last, either
    expect(daysOf(events, from.subtract({ days: 400 }), 400)).toEqual([])
    expect(daysOf(events, plainDay(bounds.until!).add({ days: 1 }), 400)).toEqual([])
    for (const { session: its, zone } of events)
      expect({ ...its, rule, zone }).toEqual({ ...session, zone: TIME_ZONE })
    expect(new Set(events.map(({ uid }) => uid)).size).toBe(events.length)
  }), { numRuns: 150 }), 30_000)

test("what one RRULE can say is one VEVENT: weekly days to their last, every nth week of them, an nth of the month; days named are a VEVENT each, and a rule with no last day none", () => {
  fc.assert(fc.property(day, simple, fc.integer({ min: 40, max: 300 }), fc.integer({ min: 1, max: 4 }), (from, rule, length, n) => {
    const until = from.add({ days: length }).toString()
    for (const one of [between(from.toString(), until, rule), ..."weekly" in rule ? [between(from.toString(), until, every(n, rule, from.toString()))] : []]) {
      const plans = plansOf(one)
      expect(plans.length).toBeLessThanOrEqual(1)
      expect(plans.every(({ rrule, exdates, until: last, first }) => rrule && !exdates.length && last === until && occurrences(one, from, length + 1)[0].equals(first))).toBe(true)
    }
    expect(plansOf(rule)).toEqual([])
    expect(plansOf(between(from.toString(), undefined, rule))).toEqual([])
  }))
  fc.assert(fc.property(day, fc.uniqueArray(fc.integer({ min: 0, max: 300 }), { minLength: 1, maxLength: 8 }), (from, offsets) => {
    const plans = plansOf(on(...offsets.map(days => from.add({ days }).toString())))
    expect(plans.map(({ first }) => String(first))).toEqual(offsets.sort((a, b) => a - b).map(days => from.add({ days }).toString()))
    expect(plans.some(({ rrule }) => rrule)).toBe(false)
  }))
})

test("every other Wednesday but a break, with a day made up, is one biweekly VEVENT with an EXDATE, and one for the day made up, never an RDATE", () =>
  fc.assert(fc.property(day, from => {
    const first = occurrences(weekly("Wed"), from, 7)[0]
    const [skipped, made] = [first.add({ weeks: 4 }).toString(), first.add({ weeks: 5, days: 1 }).toString()]
    const rule = any(except(between(first.toString(), first.add({ weeks: 10 }).toString(), every(2, weekly("Wed"), first.toString())), on(skipped)), on(made))
    const ics = writeCalendar("Test", [{ uid: "tea@notunh.app", title: "Tea", session: { rule, start: "15:00", end: "16:00" } }], instantAt(from, "09:00"))
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2)
    expect(ics.match(/RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=WE;UNTIL=\d{8}T0[34]5959Z\r\n/g)).toHaveLength(1)
    expect(ics).toContain(`EXDATE;TZID=America/New_York:${skipped.replaceAll("-", "")}T150000\r\n`)
    expect(ics).toContain(`UID:${made}-tea@notunh.app\r\nDTSTAMP:${utc(instantAt(from, "09:00"))}\r\nDTSTART;TZID=America/New_York:${made.replaceAll("-", "")}T150000\r\n`)
    expect(ics).not.toContain("RDATE")
  })))

/** Text of any characters, often those iCalendar escapes */
const escapable = (maxLength: number) =>
  fc.string({ unit: fc.oneof(fc.constantFrom("\\", ";", ",", "\n", ":", "\""), fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 })), maxLength })

test("text is escaped as written and reads back as itself, whatever it holds", () =>
  fc.assert(fc.property(escapable(200), escapable(80), day, (text, where, at) => {
    const [title, place] = [text.replace(/\r/g, "").trim() || "x", where.replace(/[\r\n]/g, " ").trim()]
    const [event] = readEvents(writeCalendar("Test", [{ uid: "one@notunh.app", title, where: place, description: title, session: { rule: on(at.toString()), start: "09:00", end: "10:00" } }], 0))
    expect(event).toMatchObject({ title, where: place, day: at.toString() })
  })))

//#endregion

//#region RRULEs read

/** RFC 5545's own examples (3.8.5.3), each from its first day: the rule, and the days it says */
const RFC: [rrule: string, first: string, days: string[]][] = [
  ["FREQ=DAILY;COUNT=10", "1997-09-02", ["09-02", "09-03", "09-04", "09-05", "09-06", "09-07", "09-08", "09-09", "09-10", "09-11"].map(day => `1997-${day}`)],
  ["FREQ=DAILY;INTERVAL=10;COUNT=5", "1997-09-02", ["1997-09-02", "1997-09-12", "1997-09-22", "1997-10-02", "1997-10-12"]],
  ["FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR", "1997-09-01", ["09-01", "09-03", "09-05", "09-15", "09-17", "09-19", "09-29", "10-01", "10-03", "10-13", "10-15", "10-17", "10-27", "10-29", "10-31", "11-10", "11-12", "11-14", "11-24", "11-26", "11-28", "12-08", "12-10", "12-12", "12-22"].map(day => `1997-${day}`)],
  ["FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO", "1997-08-05", ["1997-08-05", "1997-08-10", "1997-08-19", "1997-08-24"]],
  ["FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU", "1997-08-05", ["1997-08-05", "1997-08-17", "1997-08-19", "1997-08-31"]],
  ["FREQ=MONTHLY;COUNT=10;BYDAY=1FR", "1997-09-05", ["1997-09-05", "1997-10-03", "1997-11-07", "1997-12-05", "1998-01-02", "1998-02-06", "1998-03-06", "1998-04-03", "1998-05-01", "1998-06-05"]],
  ["FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU", "1997-09-07", ["1997-09-07", "1997-09-28", "1997-11-02", "1997-11-30", "1998-01-04", "1998-01-25", "1998-03-01", "1998-03-29", "1998-05-03", "1998-05-31"]],
  ["FREQ=MONTHLY;COUNT=6;BYDAY=-2MO", "1997-09-22", ["1997-09-22", "1997-10-20", "1997-11-17", "1997-12-22", "1998-01-19", "1998-02-16"]],
  ["FREQ=MONTHLY;BYMONTHDAY=-3;COUNT=6", "1997-09-28", ["1997-09-28", "1997-10-29", "1997-11-28", "1997-12-29", "1998-01-29", "1998-02-26"]],
  ["FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15", "1997-09-02", ["1997-09-02", "1997-09-15", "1997-10-02", "1997-10-15", "1997-11-02", "1997-11-15", "1997-12-02", "1997-12-15", "1998-01-02", "1998-01-15"]],
  ["FREQ=MONTHLY;INTERVAL=18;COUNT=10;BYMONTHDAY=10,11,12,13,14,15", "1997-09-10", ["1997-09-10", "1997-09-11", "1997-09-12", "1997-09-13", "1997-09-14", "1997-09-15", "1999-03-10", "1999-03-11", "1999-03-12", "1999-03-13"]],
  ["FREQ=MONTHLY;COUNT=5", "1997-01-31", ["1997-01-31", "1997-03-31", "1997-05-31", "1997-07-31", "1997-08-31"]],
  ["FREQ=DAILY;UNTIL=19971224T000000Z;BYDAY=SA,SU", "1997-12-13", ["1997-12-13", "1997-12-14", "1997-12-20", "1997-12-21"]]
]

test("RFC 5545's own examples fall on the days it lists for them", () => {
  for (const [rrule, first, days] of RFC) {
    const from = plainDay(first)
    const rule = ruleOfRRule(rrule, from, new Temporal.PlainTime(9), TIME_ZONE)
    expect(rule, rrule).toBeDefined()
    expect(occurrences(rule!, from.subtract({ days: 30 }), 13 * 366).map(String), rrule).toEqual(days)
  }
})

test("a rule the rules can't say isn't guessed at", () => {
  for (const rrule of ["FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2", "FREQ=YEARLY", "FREQ=YEARLY;BYMONTH=6,7", "FREQ=WEEKLY;BYMONTH=6;BYDAY=MO", "FREQ=YEARLY;BYDAY=20MO", "FREQ=MONTHLY;BYDAY=6MO", "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13", "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO", "FREQ=YEARLY;BYYEARDAY=1,100,200", "FREQ=HOURLY;INTERVAL=3", "FREQ=DAILY;BYHOUR=9,10", "FREQ=WEEKLY;INTERVAL=0", "FREQ=WEEKLY;COUNT=0", "FREQ=WEEKLY;BYDAY=XX", "FREQ=WEEKLY;UNTIL=soon", ""])
    expect(ruleOfRRule(rrule, plainDay("1997-09-02"), undefined, TIME_ZONE), rrule).toBeUndefined()
})

test("weeks counted from any day: every nth week's days are those n of the rule's own weeks apart from its first", () =>
  fc.assert(fc.property(day, fc.uniqueArray(weekday, { minLength: 1 }), fc.integer({ min: 1, max: 4 }), fc.constantFrom("MO", "TU", "WE", "TH", "FR", "SA", "SU"), (first, names, n, start) => {
    const codes = names.map(name => name.slice(0, 2).toUpperCase())
    const rule = ruleOfRRule(`FREQ=WEEKLY;INTERVAL=${n};WKST=${start};BYDAY=${codes.join(",")}`, first, undefined, TIME_ZONE)!
    // The week a day is in, counted from the day weeks start on
    const weekStart = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].indexOf(start)
    const weekOf = (at: Temporal.PlainDate) => at.subtract({ days: (at.dayOfWeek - 1 - weekStart + 7) % 7 })
    const expected = Array.from({ length: 200 }, (_, i) => first.add({ days: i }))
      .filter(at => names.includes((["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const)[at.dayOfWeek - 1]) && weekOf(first).until(weekOf(at)).days / 7 % n === 0)
    expect(occurrences(rule, first.subtract({ days: 50 }), 250).map(String)).toEqual(expected.map(String))
  })))

test("a COUNT is that many days, and an UNTIL keeps the day it's on only if that day's start isn't after it", () =>
  fc.assert(fc.property(day, simple, fc.integer({ min: 1, max: 40 }), clock, fc.integer({ min: 0, max: 400 }), clock, (first, base, count, time, after, at) => {
    const rrule = "weekly" in base ? `FREQ=WEEKLY;BYDAY=${base.weekly.map(name => name.slice(0, 2).toUpperCase()).join(",")}` : "FREQ=DAILY"
    const start = Temporal.PlainTime.from(time)
    expect(occurrences(ruleOfRRule(`${rrule};COUNT=${count}`, first, start, TIME_ZONE)!, first, 400)).toHaveLength(count)
    // UNTIL in UTC, as a zoned start requires, read on Durham's clock
    const until = first.add({ days: after }).toZonedDateTime({ timeZone: TIME_ZONE, plainTime: at })
    const stamp = until.toInstant().toString().replace(/[-:]|\.\d+/g, "")
    const kept = spansOf({ rule: ruleOfRRule(`${rrule};UNTIL=${stamp}`, first, start, TIME_ZONE)!, start: time, end: time }, first, 500)
    const all = spansOf({ rule: ruleOfRRule(rrule, first, start, TIME_ZONE)!, start: time, end: time }, first, 500)
    // But on the days the clocks change, where a time skipped or repeated isn't the instant its clock says
    fc.pre(all.every(({ start }) => hhmm(start) === time) && hhmm(until.epochMilliseconds) === at)
    expect(kept.map(({ start }) => start)).toEqual(all.filter(({ start }) => start <= until.epochMilliseconds).map(({ start }) => start))
  })))

//#endregion

//#region Zones and the clocks' changes

const vevent = (lines: string[]) =>
  ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:one", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n")

const stamp = (at: Temporal.PlainDate, time: string) =>
  `${at.toString().replaceAll("-", "")}T${time.replace(":", "")}00`

test("a weekly RRULE in Durham's zone over a year is at its time on Durham's clock every week, through both changes of the clocks", () =>
  fc.assert(fc.property(day, clock, fc.integer({ min: 1, max: 3 }), (first, time, n) => {
    // Any time but one the clocks skip in spring
    fc.pre(time < "02:00" || time >= "03:00")
    // A year and a week, which both changes of the clocks are always within
    const count = Math.ceil(54 / n) + 1
    const [event] = readEvents(vevent([`DTSTART;TZID=America/New_York:${stamp(first, time)}`, `DTEND;TZID=America/New_York:${stamp(first, time)}`, `RRULE:FREQ=WEEKLY;INTERVAL=${n};COUNT=${count}`]))
    const spans = spansOf(event.session, first, 7 * n * count, event.zone)
    expect(spans).toHaveLength(count)
    for (const span of spans)
      expect(hhmm(span.start)).toBe(time)
    // So the occurrences are a week apart but for an hour less across the spring's change and an hour more across the autumn's
    const gaps = new Set(spans.slice(1).map(({ start }, i) => start - spans[i].start - 7 * n * 24 * HOUR))
    expect(gaps).toEqual(new Set([0, -HOUR, HOUR]))
  })))

test("a time in another zone is that zone's time, whichever of the two has changed its clocks; a UTC time is UTC's, and a floating one Durham's", () =>
  fc.assert(fc.property(day, clock, fc.constantFrom("America/Los_Angeles", "Europe/London", "Asia/Kolkata", "Australia/Sydney", "UTC"), (first, time, zone) => {
    const [event] = readEvents(vevent([`DTSTART;TZID=${zone}:${stamp(first, time)}`, "DURATION:PT90M", "RRULE:FREQ=DAILY;COUNT=400"]))
    expect(event.zone).toBe(zone)
    for (const span of spansOf(event.session, first, 400, event.zone)) {
      const there = Temporal.Instant.fromEpochMilliseconds(span.start).toZonedDateTimeISO(zone)
      // But where that zone's clocks skip the time that day
      if (there.toPlainDate().toZonedDateTime({ timeZone: zone, plainTime: time }).toPlainTime().toString({ smallestUnit: "minute" }) === time)
        expect(there.toPlainTime().toString({ smallestUnit: "minute" })).toBe(time)
    }
    // As long as it says, where the clocks don't change meanwhile
    expect(event.session.end).toBe(Temporal.PlainTime.from(time).add({ minutes: 90 }).toString({ smallestUnit: "minute" }))
    const [utc] = readEvents(vevent([`DTSTART:${stamp(first, time)}Z`, `DTEND:${stamp(first, time)}Z`]))
    expect(spansOf(utc.session, first, 1, utc.zone)[0].start).toBe(Date.parse(`${first}T${time}:00Z`))
    const [floating] = readEvents(vevent([`DTSTART:${stamp(first, time)}`]))
    expect(floating.zone).toBe(TIME_ZONE)
  })))

//#endregion

//#region Real feeds

test("Athletics' calendar reads whole: every game a time in UTC, its venue unescaped", async () => {
  const events = readEvents(await fixture("events/athletics.ics"))
  expect(events).toHaveLength(12)
  expect(events.every(({ zone, session }) => zone === "UTC" && "on" in session.rule)).toBe(true)
  expect(events[0]).toMatchObject({ uid: "vcal_9584-admin.unhwildcats.com", where: "St. Paul, Minn., Lee & Penny Anderson Arena", day: "2026-09-25", session: { start: "19:00", end: "22:00" } })
})

test("a Canvas feed reads as its events at a time, each in UTC, long lines unfolded and text unescaped, what's due on a whole day left out", async () => {
  const events = readEvents(await fixture("calendars/canvas.ics"))
  expect(events.map(({ title }) => title)).toEqual(["Lecture [CS518.01-FA26]", "Lecture [CS518.01-FA26]", "Lab report 4 [CHEM403.L02-FA26]", "Exam review session [PSYC401.02-FA26]"])
  expect(told(events[0], "2026-11-01", 14)).toEqual(["2026-11-03 14:00"])
  expect(events[0]).toMatchObject({ where: "Kingsbury N343", url: "https://mycourses.unh.edu/calendar?include_contexts=course_12345&month=11&year=2026#calendar_event_98765" })
  // Due at 11:59 PM the night before, on Durham's clock, with no length
  expect(told(events[2], "2026-11-10", 7)).toEqual(["2026-11-13 23:59"])
  expect(events[2].session).toMatchObject({ start: "04:59", end: "04:59" })
})

test("a Google feed's rules read as its calendar shows them: excepted days, a moved class, a count, every other week, a first Tuesday, another zone, and no birthday", async () => {
  const events = readEvents(await fixture("calendars/google.ics"))
  const named = (title: string) => events.find(event => event.title === title)!
  expect(events.map(({ title }) => title)).toEqual(["CS 518", "CS 518 (moved)", "CS 518 lab", "AI Club", "Chess club", "Call home", "Late skate"])
  // Tuesdays and Thursdays, but the swap day, Thanksgiving, and the Thursday moved two hours later
  const lectures = told(named("CS 518"), "2026-08-01", 200)
  expect(lectures).toHaveLength(27)
  expect(lectures[0]).toBe("2026-09-01 14:00")
  expect(lectures.at(-1)).toBe("2026-12-10 14:00")
  for (const day of ["2026-10-13", "2026-10-29", "2026-11-26"])
    expect(lectures).not.toContain(`${day} 14:00`)
  // An hour of its clock lost in November changes nothing on the clock
  expect(new Set(lectures.map(told => told.slice(11)))).toEqual(new Set(["14:00"]))
  expect(told(named("CS 518 (moved)"), "2026-08-01", 200)).toEqual(["2026-10-29 16:00"])
  expect(named("CS 518 (moved)").where).toBe("Kingsbury Hall, N113")
  const labs = told(named("CS 518 lab"), "2026-08-01", 400)
  expect(labs).toHaveLength(14)
  expect(labs.at(-1)).toBe("2026-12-04 14:10")
  expect(told(named("AI Club"), "2026-08-01", 400)).toEqual(["09-16", "09-30", "10-14", "10-28", "11-11", "11-25", "12-09"].map(day => `2026-${day} 18:00`))
  expect(told(named("Chess club"), "2026-10-01", 92)).toEqual(["2026-10-06 19:00", "2026-11-03 19:00", "2026-12-01 19:00"])
  // 9 AM in Los Angeles is noon in Durham, in either season
  expect(told(named("Call home"), "2026-10-25", 21)).toEqual(["2026-10-27 12:00", "2026-11-03 12:00", "2026-11-10 12:00"])
  expect(named("Late skate").session).toMatchObject({ start: "22:00", end: "01:00", nights: 1 })
})

test("an Outlook feed reads by Windows' names for zones, a quoted parameter with a colon, EXDATEs on one line, and the last Friday of a month", async () => {
  const events = readEvents(await fixture("calendars/outlook.ics"))
  expect(events.map(({ title, zone }) => [title, zone])).toEqual([["PSYC 401", TIME_ZONE], ["Lab meeting", TIME_ZONE], ["Thesis defense", "America/Los_Angeles"], ["Timesheet", TIME_ZONE]])
  const classes = told(events[0], "2026-08-01", 200)
  expect(classes[0]).toBe("2026-08-31 13:00")
  expect(classes.at(-1)).toBe("2026-12-11 13:00")
  expect(classes).not.toContain("2026-11-25 13:00")
  expect(classes).not.toContain("2026-11-27 13:00")
  expect(events[0].uid).toBe("040000008200E00074C5B7101A82E00800000000B0A6F1C3D1E5DC01000000000000000010000000A1B2C3D4E5F60718293A4B5C6D7E8F90")
  expect(told(events[1], "2026-09-01", 122)).toEqual(["2026-09-25 12:00", "2026-10-30 12:00", "2026-11-27 12:00", "2026-12-25 12:00"])
  expect(told(events[2], "2026-12-01", 31)).toEqual(["2026-12-10 13:00"])
  // The last weekday of each month is more than the rules say, so it's told once, on its first day
  expect(told(events[3], "2026-09-01", 400)).toEqual(["2026-09-30 09:00"])
})

//#endregion
