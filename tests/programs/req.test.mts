import { test, expect } from "vitest"
import fc from "fast-check"
import { type Req, coursesIn, parseReq, renderReq, resolved } from "../../src/programs/req.mts"

const SUBJECTS = ["CS", "IT", "MATH", "CHEM", "BIOL"]
const GRADES = ["C-", "C", "C+", "B-", "B", "CR"]
// Atoms as the catalog words them, which name no course and join nothing
const ATOMS = ["SAT Math with a score of 500", "ALEKS Math Assessment with a score of 80", "Has Accred Bachelor Deg with a score of WAIV", "ACT Reading with a score of 18"]

const code = fc.tuple(fc.constantFrom(...SUBJECTS), fc.integer({ min: 400, max: 799 }), fc.constantFrom("", "", "", "H", "W"))
  .map(([subject, number, suffix]) => `${subject} ${number}${suffix}`)

const course = fc.record({ course: code, grade: fc.option(fc.constantFrom(...GRADES), { nil: undefined }), concurrent: fc.option(fc.constant(true as const), { nil: undefined }) })
  .map(({ course, grade, concurrent }): Req => ({ course, ...grade ? { grade } : {}, ...concurrent ? { concurrent } : {} }))

/** Any tree the catalog could give: groups of two to four, nested a few deep */
const req: fc.Arbitrary<Req> = fc.letrec<{ req: Req }>(tie => ({
  req: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    course,
    course,
    fc.constantFrom(...ATOMS).map((text): Req => ({ text })),
    fc.array(tie("req"), { minLength: 2, maxLength: 4 }).map((all): Req => ({ all })),
    fc.array(tie("req"), { minLength: 2, maxLength: 4 }).map((any): Req => ({ any }))
  )
})).req

/** A tree in Banner's words, as the catalog writes it: every grade said, every group bracketed */
const banner = (req: Req): string =>
  "course" in req ? `${req.course}${req.concurrent ? " (may be taken concurrently)" : ""} with a minimum grade of ${req.grade ?? "D-"}`
  : "text" in req ? req.text
  : `(${("all" in req ? req.all : req.any).map(banner).join("all" in req ? " and " : " or ")})`

/** Every course code a sentence or a tree's text names */
const codesIn = (text: string) =>
  [...text.matchAll(/\b[A-Z]{2,5} \d{3}[A-Z]{0,2}\b/g)].map(([code]) => code)

const textsIn = (req: Req): string[] =>
  "text" in req ? [req.text] : "course" in req ? [] : ("all" in req ? req.all : req.any).flatMap(textsIn)

const sorted = (codes: string[]) => [...codes].sort()

test("the Needs line reads back to the tree it was written from", () => {
  fc.assert(fc.property(req, tree => {
    expect(parseReq(renderReq(tree))).toEqual(tree)
  }), { numRuns: 300 })
})

test("Banner's words read to the same tree as the Needs line, with D- left unsaid", () => {
  fc.assert(fc.property(req, tree => {
    expect(parseReq(banner(tree) + ".")).toEqual(parseReq(renderReq(tree)))
  }), { numRuns: 300 })
  expect(parseReq("CS 416 with a minimum grade of D-")).toEqual({ course: "CS 416" })
})

test("a sentence mixing and with or unbracketed, or with brackets that don't balance, isn't guessed at", () => {
  fc.assert(fc.property(fc.array(course, { minLength: 3, maxLength: 5 }), fc.integer({ min: 1 }), (courses, seed) => {
    const ops = courses.slice(1).map((_, i) => (seed >> i) & 1 ? "and" : "or")
    fc.pre(new Set(ops).size === 2)
    const sentence = courses.map((course, i) => (i ? ` ${ops[i - 1]} ` : "") + banner(course)).join("")
    expect(parseReq(sentence)).toBeUndefined()
  }))
  fc.assert(fc.property(req, tree => {
    expect(parseReq(`(${banner(tree)}`)).toBeUndefined()
  }))
})

test("nothing a sentence names is dropped: each course is a course of the tree or in its text", () => {
  fc.assert(fc.property(req, fc.func(fc.boolean()), (tree, known) => {
    const isKnown = (code: string) => known(code)
    const read = resolved(parseReq(banner(tree))!, isKnown)
    expect(sorted([...coursesIn(read), ...textsIn(read).flatMap(codesIn)])).toEqual(sorted(coursesIn(tree)))
    expect(coursesIn(read).every(isKnown)).toBe(true)
  }))
})

test("courses not in the catalog are kept as text, as the Needs line writes them", () => {
  const tree = parseReq("CS 520 with a minimum grade of C- and (ENG 500G with a minimum grade of C or CS 415 (may be taken concurrently) with a minimum grade of D-)")!
  expect(resolved(tree, code => code.startsWith("CS"))).toEqual({ all: [{ course: "CS 520", grade: "C-" }, { any: [{ text: "ENG 500G (C)" }, { course: "CS 415", concurrent: true }] }] })
})

test("the Needs line is terse: and, or, all of, one of, a subject only where it changes, a grade only past D-", () => {
  const line = (sentence: string) => renderReq(parseReq(sentence)!)
  expect(line("CS 416 with a minimum grade of D- or CS 417 with a minimum grade of D-")).toBe("CS 416 or 417")
  expect(line("CS 515 with a minimum grade of C- and CS 518 with a minimum grade of D-")).toBe("CS 515 (C-) and 518")
  expect(line("CS 520 with a minimum grade of C- and ((CS 619 with a minimum grade of D- and CS 620 with a minimum grade of D-) or (CS 620 with a minimum grade of D- and (CS 727 with a minimum grade of D- or IT 666 with a minimum grade of D-)) )"))
    .toBe("CS 520 (C-) and ((CS 619 and 620) or (CS 620 and (CS 727 or IT 666)))")
  expect(line("(MATH 418 with a minimum grade of C or MATH 418H with a minimum grade of C or ALEKS Math Assessment with a score of 80)"))
    .toBe("one of MATH 418 (C), 418H (C), ALEKS Math Assessment with a score of 80")
  expect(line("MATH 425 (may be taken concurrently) with a minimum grade of C-")).toBe("MATH 425 (C-, or concurrently)")
})
