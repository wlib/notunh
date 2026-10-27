import { test, expect } from "vitest"
import fc from "fast-check"
import { ALPHABET, LENGTH, codeOf, linkUrl, parseCode, shown } from "../../src/social/link.mts"

test("a code from any bytes is eight letters and digits from the alphabet, without 0, O, 1, I or L, shown in halves", () =>
  fc.assert(fc.property(fc.uint8Array({ minLength: LENGTH, maxLength: 32 }), bytes => {
    const code = codeOf(bytes)
    expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/)
    expect(code).not.toMatch(/[01OIL]/)
    expect(parseCode(code)).toBe(code.replace("-", ""))
  }))
)

test("a code is read back however it's typed: any case, with or without the dash, spaces, or the link around it", () =>
  fc.assert(fc.property(
    fc.string({ unit: fc.constantFrom(...ALPHABET), minLength: LENGTH, maxLength: LENGTH }),
    fc.constantFrom("", " ", "-", " - ", "·"),
    fc.boolean(),
    (code, between, isLower) => {
      const typed = `${code.slice(0, 4)}${between}${code.slice(4)}`
      expect(parseCode(isLower ? typed.toLowerCase() : typed)).toBe(code)
      expect(parseCode(shown(code))).toBe(code)
      expect(parseCode(` ${shown(code)} `)).toBe(code)
      expect(linkUrl("https://notunh.app", shown(code))).toBe(`https://notunh.app/map/#link=${code}`)
    }
  ))
)

test("anything else isn't a code: too short, too long, or with a letter outside the alphabet", () => {
  expect(parseCode("ABCD-EFG")).toBeUndefined()
  expect(parseCode("ABCD-EFGHJ")).toBeUndefined()
  expect(parseCode("ABCD-EFG0")).toBeUndefined()
  expect(parseCode("ABCD-EFGI")).toBeUndefined()
  expect(parseCode("")).toBeUndefined()
})
