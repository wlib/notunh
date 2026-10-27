import { test, expect } from "vitest"
import fc from "fast-check"
import { createCourseSearch, crnsIn, parseCode, parseRoom } from "../../src/courses/search.mts"
import { createPeople } from "../../src/courses/people.mts"
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
  }), { numRuns: 500 })
)

test("five digits are a CRN, and a pasted schedule is every CRN it names", () => {
  fc.assert(fc.property(fc.constantFrom(...fall.sections), section => {
    expect(search(section.crn).sections).toEqual([{ term: fall, section }])
  }))
  fc.assert(fc.property(fc.uniqueArray(fc.constantFrom(...fall.sections), { minLength: 2, maxLength: 8 }), sections => {
    const pasted = sections.map(section => `${section.crn}\t${section.subject} ${section.number}\t${section.title}`).join("\n")
    expect(search(pasted).sections.map(({ section }) => section.crn)).toEqual(sections.map(({ crn }) => crn))
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

test("a search answers in a few milliseconds", () => {
  const started = performance.now()
  for (let i = 0; i < 100; i++)
    search("organic chemistry")
  expect((performance.now() - started) / 100).toBeLessThan(10)
})
