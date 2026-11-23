import { test, expect } from "vitest"
import fc from "fast-check"
import { DISPATCH, PHONES, phonesFor, telOf } from "../../src/map/phones.mts"

const ALL = PHONES.flatMap(({ phones }) => phones)

test("every number is from a unh.edu page, dials as written, and names no one", () => {
  for (const phone of ALL) {
    expect(new URL(phone.source).hostname).toMatch(/(^|\.)unh\.edu$/)
    expect(new URL(phone.source).protocol).toBe("https:")
    expect(phone.number).toMatch(/^(\d{3}|\(\d{3}\) \d{3}-\d{4})$/)
    expect(telOf(phone)).toBe(phone.number.length === 3 ? phone.number : `+1${phone.number.replace(/\D/g, "")}`)
    expect(`${phone.name} ${phone.note ?? ""}`).not.toMatch(/@/)
  }
})

test("emergency comes first, 911 before UNH Police's dispatch", () => {
  expect(PHONES[0].heading).toBe("Emergency")
  expect(PHONES[0].phones.map(({ number }) => number)).toEqual(["911", DISPATCH.number])
})

test("search finds a number by the start of any word of its name or note, and the page for those or a word like phone", () => {
  expect(phonesFor("police").phones.map(({ number }) => number)).toEqual(["911", DISPATCH.number])
  expect(phonesFor("police disp").phones).toEqual([DISPATCH])
  expect(phonesFor("COUNSEL").phones.map(({ name }) => name)).toEqual(["Psychological & Counseling Services"])
  expect(phonesFor("sharpp").isPage).toBe(true)
  expect(phonesFor("phone numbers")).toEqual({ isPage: true, phones: [] })
  expect(phonesFor("emergency").phones[0].number).toBe("911")
  expect(phonesFor("Kingsbury")).toEqual({ isPage: false, phones: [] })
  expect(phonesFor("po")).toEqual({ isPage: false, phones: [] })
})

test("each number is found by its own name, and anything found is the page's too", () =>
  fc.assert(fc.property(fc.constantFrom(...ALL), fc.string(), (phone, typed) => {
    expect(phonesFor(phone.name).phones).toContain(phone)
    const found = phonesFor(typed)
    if (found.phones.length)
      expect(found.isPage).toBe(true)
  }))
)
