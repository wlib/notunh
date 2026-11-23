import { test, expect } from "vitest"
import fc from "fast-check"
import { byCourse, createCourseSearch, crnsIn, parseCode, parseRoom } from "../../src/courses/search.mts"
import { createPeople } from "../../src/courses/people.mts"
import { courseOf } from "../../src/courses/course.mts"
import { fall, spring } from "./fixtures.mts"

const search = createCourseSearch([fall], createPeople([fall]))
const empty = { people: [], sections: [], rooms: [] }

test("a course code in any spelling finds its sections, and a section number narrows to one", () =>
  fc.assert(fc.property(fc.constantFrom(...fall.sections), fc.constantFrom(" ", "", "-"), fc.constantFrom("", " ", "-", " ("), fc.boolean(), (section, gap, sep, lower) => {
    const code = `${section.subject}${gap}${section.number}`
    const query = lower ? code.toLowerCase() : code
    const found = search(query).sections
    expect(found.length).toBeGreaterThan(0)
    expect(found.every(({ section: found }) => found.subject === section.subject && found.number.startsWith(section.number))).toBe(true)
    // A lab section like "L10" needs a separator after the number, since "401L10" could be course 401L
    const between = sep === "" && /^[A-Z]/i.test(section.section) ? " " : sep
    const exact = search(`${query}${between}${section.section}${between === " (" ? ")" : ""}`).sections
    expect(exact.map(({ section }) => section.crn)).toContain(section.crn)
    expect(exact.every(({ section: found }) => found.section.toUpperCase() === section.section.toUpperCase())).toBe(true)
  }), { numRuns: 100 })
)

test("five digits are a CRN, finding its section alone, or nothing", () => {
  fc.assert(fc.property(fc.constantFrom(...fall.sections), section => {
    expect(search(section.crn).sections).toEqual([{ term: fall, section }])
  }))
  expect(search("99999")).toEqual(empty)
})

test("titles are found fuzzily, best first, and names find people in their own group", () => {
  expect(search("intro to psychology").sections[0].section.title).toMatch(/Psychology/)
  expect(search("Programming Language Concepts").sections[0].section.subject).toBe("CS")
  const someone = fall.sections.find(section => section.instructors.length)!.instructors[0].name.split(" ").at(-1)!
  expect(search(someone).people.some(person => person.name.endsWith(someone))).toBe(true)
  expect(search("")).toEqual(empty)
  expect(search("zzzzzzzz")).toEqual(empty)
})

test("a room reads as a room, with or without its building, as the registrar or the map names it, and never as a code or a CRN", () => {
  expect(parseRoom("N343")).toEqual({ building: undefined, room: "N343" })
  expect(parseRoom("Kingsbury N343")).toEqual({ building: "kingsbury", room: "N343" })
  expect(parseRoom("James 140")).toEqual({ building: "james", room: "140" })
  expect(parseRoom("G85")).toEqual({ building: undefined, room: "G85" })
  expect(parseRoom("12345")).toBeUndefined()
  expect(parseRoom("psychology")).toBeUndefined()
  expect(search("CS 520").rooms).toEqual([])
  expect(search("Kingsbury Hall N343").rooms.map(({ where }) => where)).toEqual(["Kingsbury N343"])
  expect(search("kingsbury n343").rooms.map(({ place }) => place)).toEqual(["Kingsbury Hall"])
  const wheres = fall.sections.flatMap(section => section.meetings.filter(meeting => meeting.days && meeting.place).map(meeting => meeting.where))
  fc.assert(fc.property(fc.constantFrom(...wheres), where => {
    if (parseRoom(where.split(" ").at(-1)!))
      expect(search(where).rooms.map(room => room.where)).toContain(where)
  }), { numRuns: 100 })
})

test("parseCode reads subject, number and section however they're spaced, and nothing else as a code", () => {
  expect(parseCode("CS 520")).toEqual({ subject: "CS", number: "520", section: undefined })
  expect(parseCode("cs520-01")).toEqual({ subject: "CS", number: "520", section: "01" })
  expect(parseCode("MATH 425 (3)")).toEqual({ subject: "MATH", number: "425", section: "03" })
  expect(parseCode("ENGL 401H")).toEqual({ subject: "ENGL", number: "401H", section: undefined })
  expect(parseCode("CHEM 403 NL1")).toEqual({ subject: "CHEM", number: "403", section: "NL1" })
  expect(parseCode("intro to psychology")).toBeUndefined()
  expect(parseCode("12345")).toBeUndefined()
})

test("a pasted schedule gives back the sections it names, each once, in order, from the earlier term where two terms share a CRN, and nothing else", () => {
  fc.assert(fc.property(fc.array(fc.constantFrom(...fall.sections), { maxLength: 8 }), fc.string(), (sections, noise) => {
    const pasted = sections.map(section => `${section.crn} ${section.subject} ${section.number} ${noise.replace(/\d/g, "")} 99999`).join("\n")
    expect(crnsIn(pasted, [fall]).map(({ section }) => section.crn)).toEqual([...new Set(sections.map(section => section.crn))])
  }))
  const shared = fall.sections.find(section => spring.sections.some(other => other.crn === section.crn))
  if (shared)
    expect(crnsIn(shared.crn, [fall, spring])[0].term).toBe(fall)
})

test("searching several terms puts the earlier term's sections first", () => {
  const both = createCourseSearch([fall, spring])
  const found = both("CS 518").sections
  expect(found.length).toBeGreaterThan(0)
  const firstSpring = found.findIndex(({ term }) => term === spring)
  if (firstSpring >= 0)
    expect(found.slice(firstSpring).every(({ term }) => term === spring)).toBe(true)
})

/** A query cased any which way, letter by letter */
const anyCase = (text: string) =>
  fc.array(fc.boolean(), { minLength: text.length, maxLength: text.length }).map(upper => [...text].map((letter, i) => upper[i] ? letter.toUpperCase() : letter.toLowerCase()).join(""))

test("unlimited, any section's own code in any spacing or case finds it, under its course, and only that course", () =>
  fc.assert(fc.property(fc.constantFrom(...fall.sections).chain(section => fc.tuple(fc.constant(section), anyCase(section.subject), fc.constantFrom("", " ", "  ", "-", " - "), fc.constantFrom("", " ", "\t"))), ([section, subject, gap, pad]) => {
    const found = byCourse(search(`${pad}${subject}${gap}${section.number}${pad}`, Infinity).sections)
    expect(found.flatMap(({ sections }) => sections.map(({ section }) => section.crn))).toContain(section.crn)
    expect(found.every(({ code }) => code.startsWith(courseOf(section)))).toBe(true)
  }), { numRuns: 200 })
)

test("unlimited, any section's title in any case finds its course", () =>
  fc.assert(fc.property(fc.constantFrom(...fall.sections).chain(section => fc.tuple(fc.constant(section), anyCase(section.title))), ([section, title]) => {
    const codes = byCourse(search(title, Infinity).sections).map(({ code }) => code)
    expect(codes).toContain(courseOf(section))
  }), { numRuns: 100 })
)

test("a limit caps the sections found, eight unless it's said, and Infinity lists them all", () => {
  const big = Object.entries(Object.groupBy(fall.sections, courseOf)).map(([code, sections]) => ({ code, count: sections!.length })).sort((a, b) => b.count - a.count)[0]
  expect(search(big.code).sections.length).toBe(Math.min(8, big.count))
  expect(search(big.code, Infinity).sections.length).toBe(fall.sections.filter(section => courseOf(section).startsWith(big.code)).length)
  expect(search(big.code, 1).sections).toHaveLength(1)
})

test("byCourse keeps every section once, a term's course together, in the order first found", () =>
  fc.assert(fc.property(fc.array(fc.constantFrom(...fall.sections, ...spring.sections.slice(0, 50)).map(section => ({ term: fall.sections.includes(section) ? fall : spring, section }))), found => {
    const courses = byCourse(found)
    expect(courses.flatMap(({ sections }) => sections).toSorted((a, b) => found.indexOf(a) - found.indexOf(b))).toEqual(found)
    expect(new Set(courses.map(({ term, code }) => `${term.code} ${code}`)).size).toBe(courses.length)
    expect(courses.every(({ term, code, sections }) => sections.every(one => one.term === term && courseOf(one.section) === code))).toBe(true)
    const firsts = courses.map(({ sections }) => found.indexOf(sections[0]))
    expect(firsts).toEqual(firsts.toSorted((a, b) => a - b))
  }))
)
