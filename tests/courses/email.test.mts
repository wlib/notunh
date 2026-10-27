import { test, expect } from "vitest"
import fc from "fast-check"
import { LOOKS_LIKE_EMAIL, hide, mailto, reveal } from "../../src/courses/email.mts"
import { fall, jterm, spring } from "./fixtures.mts"

const anEmail = fc.tuple(
  fc.stringMatching(/^[a-z][a-z0-9._'-]{0,20}$/),
  fc.constantFrom("unh.edu", "wildcats.unh.edu", "usnh.edu", "example.org")
).map(([user, domain]) => `${user}@${domain}`)

test("reveal(hide(x)) is x, and what's hidden never looks like an address or holds an at sign or a dot", () =>
  fc.assert(fc.property(anEmail, email => {
    const hidden = hide(email)
    expect(reveal(hidden)).toBe(email)
    expect(mailto(hidden)).toBe(`mailto:${email}`)
    expect(hidden).not.toMatch(LOOKS_LIKE_EMAIL)
    expect(hidden).not.toContain("@")
    expect(hidden).not.toContain(".")
    expect(hidden.toLowerCase()).not.toContain("edu")
  }))
)

test("two addresses hide to two strings", () =>
  fc.assert(fc.property(anEmail, anEmail, (a, b) => {
    expect(hide(a) === hide(b)).toBe(a === b)
  }))
)

test("the term files as they'd ship hold no address in the clear, and every hidden one reveals to a UNH address", () => {
  for (const term of [fall, jterm, spring]) {
    const json = JSON.stringify({ code: term.code, sections: term.sections })
    expect(json).not.toMatch(LOOKS_LIKE_EMAIL)
    expect(json).not.toMatch(/mailto:/)
  }
  const hidden = fall.sections.flatMap(section => section.instructors.flatMap(({ mail }) => mail ?? []))
  expect(hidden.length).toBeGreaterThan(300)
  for (const mail of hidden)
    expect(reveal(mail)).toMatch(/^[a-z0-9._'-]+@(unh|usnh)\.edu$/)
})
