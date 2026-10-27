import { test, expect } from "vitest"
import fc from "fast-check"
import { spellGreek } from "../../src/shared/fuzzy.mts"

const NAMES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa", "Lambda", "Mu", "Nu", "Xi", "Omicron", "Pi", "Rho", "Sigma", "Tau", "Upsilon", "Phi", "Chi", "Psi", "Omega"]
const CAPITALS = "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ"
const SMALL = "αβγδεζηθικλμνξοπρστυφχψω"

test("Greek letters, capital or small, are spelled out as words by their names, as a fraternity's are", () =>
  fc.assert(fc.property(fc.array(fc.nat(23), { minLength: 1, maxLength: 4 }), fc.boolean(), (letters, isSmall) => {
    const written = letters.map(i => (isSmall ? SMALL : CAPITALS)[i]).join("")
    expect(spellGreek(written)).toBe(letters.map(i => NAMES[i]).join(" "))
  }))
)

test("a final sigma is a sigma, and text without Greek letters is as it was, but for its spaces", () => {
  expect(spellGreek("φις")).toBe("Phi Iota Sigma")
  expect(spellGreek("Sig Ep")).toBe("Sig Ep")
  expect(spellGreek("ΣΦΕ house")).toBe("Sigma Phi Epsilon house")
})
