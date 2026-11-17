import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import type { Section } from "../../src/courses/course.mts"
import type { Event } from "../../src/social/event.mts"
import type { Gazetteer } from "../../src/places/gazetteer.mts"
import { placeMatcher } from "../../src/social/aliases.mts"
import { classOf, leadsOf, listedAs, pageExcluded, passagesOf, robotsAllows, scoreOf, wordingExcluded } from "../../src/social/leads.mts"
import { whenOf } from "../../src/social/when.mts"
import { addDays, atClock, daysBetween, localDay, weekday } from "../../src/shared/time.mts"

const gazetteer: Gazetteer = JSON.parse(await readFile(new URL("../fixtures/data/src/map/gazetteer.json", import.meta.url), "utf8"))
const match = placeMatcher(gazetteer.places.map(place => place.name))

/** Today, as each run of the tests has it, and a day within a year of it */
const today = localDay(Date.now())
const day = fc.integer({ min: -365, max: 365 }).map(days => addDays(today, days))

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

/** A time of day as UNH's pages write one, and as "HH:MM" */
const written = fc.record({
  hour:   fc.integer({ min: 1, max: 12 }),
  minute: fc.constantFrom(0, 10, 15, 30, 40, 45),
  pm:     fc.boolean(),
  style:  fc.constantFrom("4pm", "4 PM", "4 p.m.")
}).map(({ hour, minute, pm, style }) => ({
  text:  `${hour}${minute ? `:${String(minute).padStart(2, "0")}` : style === "4pm" ? "" : ":00"}${style === "4pm" ? (pm ? "pm" : "am") : style === "4 PM" ? (pm ? " PM" : " AM") : (pm ? " p.m." : " a.m.")}`,
  clock: `${String(hour % 12 + (pm ? 12 : 0)).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}))

test("a weekly passage reads as its weekday, its window and that it's again and again, however its times are written", () =>
  fc.assert(fc.property(fc.integer({ min: 0, max: 6 }), written, written, fc.constantFrom("-", "–", " to "), fc.boolean(), (on, from, to, dash, plural) => {
    fc.pre(from.clock < to.clock)
    const text = plural
      ? `Conversation Hour: ${DAY_NAMES[on]}s ${from.text}${dash}${to.text} in the Murkland G10 Lounge`
      : `Conversation Hour: ${from.text}${dash}${to.text} every ${DAY_NAMES[on]} in the Murkland G10 Lounge`
    expect(whenOf(text, today)).toEqual({ days: [on], times: [{ start: from.clock, end: to.clock }], dates: [], recurring: true })
  })))

test("a range with one meridiem reads its start by its end's, unless that starts it after its end", () => {
  expect(whenOf("2-3pm every Friday", today)?.times).toEqual([{ start: "14:00", end: "15:00" }])
  expect(whenOf("12:40-1:40 Tuesdays", today)?.times).toEqual([{ start: "12:40", end: "13:40" }])
  expect(whenOf("11-1pm on Mondays", today)?.times).toEqual([{ start: "11:00", end: "13:00" }])
  expect(whenOf("every Thursday at noon", today)?.times).toEqual([{ start: "12:00" }])
  expect(whenOf("Monday–Friday 8am-4:30pm", today)?.days).toEqual([0, 1, 2, 3, 4])
  expect(whenOf("Open from midnight on Fridays", today)?.times).toEqual([{ start: "00:00" }])
  // A meridiem is "am" or "pm", not an "a" or a "p" alone
  expect(whenOf("Groups of 3-4 people meet on Friday", today)).toBeUndefined()
  // Neither a word that starts like a month nor a day no month has is a date
  expect(whenOf("Marketing 10 on Tuesdays 3-4pm", today)?.dates).toEqual([])
  expect(whenOf("Tea on 2/30 from 3-4pm", today)?.dates).toEqual([])
})

test("text stating no time of day is no lead, nor a time alone with no day, date or end, nor numbers alone", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 12 }), fc.integer({ min: 0, max: 12 }), fc.constantFrom("grades", "won", "Gr", "Mondays"), (a, b, word) => {
    expect(whenOf(`${word} ${a}-${b}`, today)).toBeUndefined()
  }))
  fc.assert(fc.property(fc.string().filter(text => !/\d|noon|midnight/i.test(text)), text => { expect(whenOf(text, today)).toBeUndefined() }))
  fc.assert(fc.property(fc.integer({ min: 1, max: 12 }), hour => { expect(whenOf(`Call us at ${hour}pm or email`, today)).toBeUndefined() }))
  expect(whenOf("Call 603-862-1234", today)).toBeUndefined()
})

test("a date written without its year is read in the year nearest today", () =>
  fc.assert(fc.property(day, on => {
    const [, month, date] = on.split("-").map(Number)
    const [read] = whenOf(`Tea Hour 3-4pm on ${month}/${date}`, today)!.dates
    expect(read.slice(5)).toBe(on.slice(5))
    expect(Math.abs(daysBetween(today, read))).toBeLessThanOrEqual(184)
  })))

test("a passage with a course code of a subject the registrar has is a course; a building's letters aren't", () =>
  fc.assert(fc.property(fc.constantFrom("RUSS", "CS", "MATH", "FREN"), fc.integer({ min: 400, max: 999 }), written, (subject, number, time) => {
    const subjects = new Set(["RUSS", "CS", "MATH", "FREN"])
    const when = whenOf(`Tuesdays ${time.text}`, today)!
    expect(wordingExcluded(`${subject} ${number} meets Tuesdays ${time.text}`, when, subjects)).toBe(`a course (${subject} ${number})`)
    expect(wordingExcluded(`Drop in at MUB ${number} Tuesdays ${time.text}`, when, subjects)).toBeUndefined()
  })))

test("credits, prerequisites, a front desk's hours, and a deadline with no window aren't leads", () => {
  const subjects = new Set<string>()
  const reason = (text: string) => wordingExcluded(text, whenOf(text, today)!, subjects)
  expect(reason("4 credits, meets Mondays 9-10am")).toBe("a course")
  expect(reason("Prerequisite: none. Thursdays 2-3pm")).toBe("a course")
  expect(reason("Front desk hours: Monday–Friday 8am-4:30pm")).toBe("hours a place is open")
  expect(reason("Applications are due Friday at 5pm")).toBe("a deadline")
  expect(reason("Events on Monday must be cancelled by noon on the previous Friday")).toBe("a deadline")
  expect(reason("Shifts fall between 8 a.m. - 4:30 p.m., Monday through Friday")).toBe("a job")
  expect(reason("Free on weekends and after 6 p.m. weekdays at the Alumni Lot parking")).toBe("parking")
  expect(reason("Open Wednesday-Sunday 12-5pm")).toBe("hours a place is open")
  // What's open to go to isn't a place's hours, nor is a skate park's meetup parking, nor a lecture series a course
  expect(reason("Open Skate: Fridays 1-2pm at the Whittemore Center")).toBeUndefined()
  expect(reason("Skate park meetup Saturdays 2-4pm")).toBeUndefined()
  expect(reason("Lecture series: Thursdays 4-5pm")).toBeUndefined()
  expect(reason("Russian Conversation Hour: 2-3pm every Friday in the Murkland G10 Lounge")).toBeUndefined()
})

/** A class meeting at a place on a weekday, as the registrar's sections have them, running through a day */
const sectionAt = (place: string, letter: string, start: number, to: string): Section => ({
  crn: "10001", subject: "RUSS", number: "401", section: "01", title: "Russian", kind: "LEC", mode: "IPFF", credits: "4.0",
  from: addDays(to, -100), to, instructors: [], crossListed: [],
  meetings: [{ days: letter, start, end: start + 50, from: addDays(to, -100), to, place, where: `${place} 210` }]
})

test("a passage that's a class meeting is one: its place, a weekday of it, and a start within a quarter hour", () =>
  fc.assert(fc.property(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 8 * 60, max: 20 * 60 }), fc.integer({ min: -40, max: 40 }), (on, start, off) => {
    const minutes = start + off
    const clock = `${Math.floor(minutes / 60) % 12 || 12}:${String(minutes % 60).padStart(2, "0")}${minutes >= 720 ? "pm" : "am"}`
    const when = whenOf(`${DAY_NAMES[on]}s at ${clock}`, today)!
    const section = sectionAt("Murkland Hall", "MTWRF"[on], start, addDays(today, 30))
    expect(classOf("in Murkland 210", when, "Murkland Hall", [section], today) !== undefined).toBe(Math.abs(off) <= 15)
    expect(classOf("in Murkland 210", when, "Hamilton Smith Hall", [section], today)).toBeUndefined()
    // Another room of the building isn't the class's
    expect(classOf("in the Murkland G10 Lounge", when, "Murkland Hall", [section], today)).toBeUndefined()
    // A term that's over has no classes
    expect(classOf("in Murkland 210", when, "Murkland Hall", [sectionAt("Murkland Hall", "MTWRF"[on], start, addDays(today, -1))], today)).toBeUndefined()
  })))

test("a passage a calendar already tells is listed: an event at its place on one of its weekdays, near its time", () =>
  fc.assert(fc.property(day, fc.integer({ min: 9, max: 20 }), (on, hour) => {
    const event: Event = { id: "25live:1", title: "Tea", start: atClock(on, `${hour}:00`), end: atClock(on, `${hour + 1}:00`), place: "Murkland Hall", where: "", source: "25live", url: "" }
    const when = whenOf(`${DAY_NAMES[weekday(on)]}s ${hour % 12 || 12}-${(hour + 1) % 12 || 12}${hour + 1 >= 12 ? "pm" : "am"}`, today)!
    expect(listedAs(when, "Murkland Hall", [event])).toBe(event)
    expect(listedAs(when, "Dimond Library", [event])).toBeUndefined()
    expect(listedAs({ ...when, days: [(weekday(on) + 1) % 7] }, "Murkland Hall", [event])).toBeUndefined()
  })))

test("people, the catalog, admissions and policies are never read, nor news over a term old", () =>
  fc.assert(fc.property(fc.integer({ min: 0, max: 400 }), fc.uuid(), (age, slug) => {
    expect(pageExcluded(`https://www.unh.edu/person/${slug}`, undefined, today)).toBe("a person's page")
    expect(pageExcluded(`https://catalog.unh.edu/undergraduate/${slug}`, undefined, today)).toBe("the course catalog")
    expect(pageExcluded(`https://students.unh.edu/mub-policy-manual/${slug}`, undefined, today)).toBe("a policy")
    expect(pageExcluded(`https://cola.unh.edu/languages-literatures-cultures/${slug}`, undefined, today)).toBeUndefined()
    expect(pageExcluded(`https://www.unh.edu/admissions-aid/${slug}`, undefined, today)).toBe("admissions")
    expect(pageExcluded(`https://www.unh.edu/unh-today/news/${slug}`, addDays(today, -age), today)).toBe(age > 120 ? "news over a term old" : undefined)
  })))

test("a passage naming only past dates scores lower than the same passage naming coming ones", () =>
  fc.assert(fc.property(fc.integer({ min: 1, max: 150 }), days => {
    const [past, coming] = [addDays(today, -days), addDays(today, days)].map(on => `Tea Hour: 3-4pm in the Murkland G10 Lounge ${on.slice(5).replace("-", "/").replace(/^0/, "").replace("/0", "/")}`)
    expect(scoreOf(past, whenOf(past, today)!, "Murkland Hall", today)).toBeLessThan(scoreOf(coming, whenOf(coming, today)!, "Murkland Hall", today))
  })))

test("a page's passages are its <main>'s, under their headings, with nobody's address", () =>
  fc.assert(fc.property(fc.emailAddress(), mail => {
    const html = `<header><p>Mondays 9-10am</p></header><main><h2>Russian</h2><ul><li>Russian Conversation Hour: 2-3pm every Friday. Ask ${mail}</li></ul><p>Tea is on. Bring a mug.</p></main><footer>Fridays 1-2pm</footer>`
    const passages = passagesOf(html, "https://cola.unh.edu/x")
    expect(passages.map(({ text }) => text)).toEqual(["Russian Conversation Hour: 2-3pm every Friday. Ask (address)", "Tea is on.", "Bring a mug."])
    expect(passages[0].heading).toBe("Russian")
    // A sentence ending in "p.m." before its days keeps them
    expect(passagesOf("<main><p>Tea from 2 to 3 p.m. Monday through Friday. Bring a mug.</p></main>", "https://x.unh.edu").map(({ text }) => text)).toEqual(["Tea from 2 to 3 p.m. Monday through Friday.", "Bring a mug."])
    expect(JSON.stringify(passages)).not.toContain(mail)
    expect(passagesOf("<main><p>Call (603) 862-2090 or 603-862-1234 from 2-3pm Fridays.</p></main>", "https://x.unh.edu")[0].text).toBe("Call (phone) or (phone) from 2-3pm Fridays.")
  })))

test("leads are placed, scored, and left out with a reason", () => {
  const passages = passagesOf("<main><ul><li>Russian Conversation Hour: 2-3pm every Friday in the Murkland G10 Lounge</li><li>RUSS 401: MWF 10:10-11am, 4 credits</li><li>No times here</li></ul></main>", "https://cola.unh.edu/x")
  const leads = leadsOf(passages, match, { subjects: new Set(["RUSS"]), sections: [], events: [] }, today)
  expect(leads).toHaveLength(2)
  const [lead, course] = leads
  // Again and again, three words of things to go to, a weekday, and a place
  expect(lead).toMatchObject({ place: "Murkland Hall", score: 12, when: { days: [4], times: [{ start: "14:00", end: "15:00" }] } })
  expect(course).toMatchObject({ reason: "a course (RUSS 401)" })
})

test("robots.txt is read as any crawler's: the longest rule deciding, an Allow winning a tie", () => {
  const robots = "User-agent: *\nDisallow: /sites/default/files/*.pdf$\nDisallow: /private\nAllow: /private/open\n\nUser-agent: Other\nDisallow: /"
  expect(robotsAllows(robots, "/languages")).toBe(true)
  expect(robotsAllows(robots, "/private/x")).toBe(false)
  expect(robotsAllows(robots, "/private/open/x")).toBe(true)
  expect(robotsAllows(robots, "/sites/default/files/a.pdf")).toBe(false)
  fc.assert(fc.property(fc.webPath(), path => { expect(robotsAllows("", path)).toBe(true) }))
})
