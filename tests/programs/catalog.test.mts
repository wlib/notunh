import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile, readdir } from "node:fs/promises"
import { CATALOG, INDEX_URL, isAllowed, isDurham, pageOf, prerequisitesOf, readPrerequisites, subjectsOf, withUnlocks } from "../../src/programs/catalog.mts"
import { FIXES } from "../../src/programs/fixes.mts"
import { type Req, coursesIn, parseReq } from "../../src/programs/req.mts"
import { Prereqs, reqsOf } from "../../src/programs/prereqs.mts"
import * as v from "valibot"

// Subjects' description pages trimmed to their titles and requisites, and the index of subjects trimmed to its links
const FIXTURES = new URL("../fixtures/programs/", import.meta.url)
const files = (await readdir(FIXTURES)).filter(name => name.endsWith(".html") && name !== "index.html")
const pages = await Promise.all(files.map(async name => pageOf(await readFile(new URL(name, FIXTURES), "utf8"))))
const all = pages.flatMap(page => page.courses)
const { data, coverage } = prerequisitesOf(pages, 0)

const textsIn = (req: Req): string[] =>
  "text" in req ? [req.text] : "course" in req ? [] : ("all" in req ? req.all : req.any).flatMap(textsIn)

test("CS 518 needs CS 416 or 417 and unlocks CS 619 and IT 705", () => {
  expect(reqsOf(data, "CS 518")).toEqual({ needs: "CS 416 or 417", unlocks: ["CS 619", "IT 705"] })
  expect(reqsOf(data, "CS 619").needs).toBe("CS 515 (C-) and 518")
  expect(reqsOf(data, "CS 791").needs).toBe("CS 520 (C-) and ((CS 619 and 620) or (CS 620 and (CS 727 or IT 666)))")
  expect(reqsOf(data, "NOPE 999")).toEqual({ needs: "", unlocks: [] })
})

test("only Durham's subjects are read, never Professional Studies' or Manchester's", async () => {
  expect(pages.filter(page => !isDurham(page.title)).map(page => page.title).sort())
    .toEqual(["Computing Technology (COMP)", "Critical Thinking (CRIT) CPSO", "Mathematics (MTH) CPSO"])
  expect(Object.keys(data.courses).some(code => /^(MTH|CRIT|COMP) /.test(code))).toBe(false)
  const subjects = subjectsOf(await readFile(new URL("index.html", FIXTURES), "utf8"))
  expect(subjects.length).toBe(176)
  expect(subjects.find(subject => subject.url === `${INDEX_URL}cs/`)).toEqual({ url: `${INDEX_URL}cs/`, title: "Computer Science (CS)" })
  expect(subjects.filter(subject => isDurham(subject.title)).length).toBe(123)
})

test("only the course-description pages are ever asked for, never /search/, /ribbit/, or /archives/", () => {
  expect(isAllowed(INDEX_URL)).toBe(true)
  expect(isAllowed(`${INDEX_URL}cs/`)).toBe(true)
  fc.assert(fc.property(fc.webPath(), fc.constantFrom("/search/", "/ribbit/", "/archives/", "/courseleaf/", "/undergraduate/programs-study/"), (path, disallowed) => {
    expect(isAllowed(`${CATALOG}${disallowed}${path}`)).toBe(false)
    expect(isAllowed(`${INDEX_URL}cs/${path.replace(/^\//, "")}?P=CS%20518`)).toBe(false)
  }))
})

test("all but a few sentences read for sure, the rest kept whole as text", () => {
  expect(coverage.read / coverage.withPrerequisites).toBeGreaterThanOrEqual(0.97)
  for (const code of coverage.unread)
    expect(data.courses[code].needs).toEqual({ text: all.find(course => course.code === code)!.prerequisites })
})

test("the broken sentences aren't guessed at, and each fix reads only while the catalog says exactly what was fixed", () => {
  for (const [code, { from, to }] of Object.entries(FIXES)) {
    expect(parseReq(from)).toBeUndefined()
    expect(readPrerequisites(code, from)).toEqual(parseReq(to))
    expect(parseReq(to)).toBeDefined()
    expect([...coursesIn(parseReq(to)!)].sort()).toEqual([...from.matchAll(/\b[A-Z]{2,5} \d{3}[A-Z]?\b/g)].map(([code]) => code).sort())
    expect(readPrerequisites(code, `${from} or CS 999`)).toBeUndefined()
  }
  expect(Object.keys(FIXES).filter(code => all.some(course => course.code === code)).length).toBeGreaterThan(0)
  const changed = prerequisitesOf([{ title: "Biomedical Science (BMS)", courses: [{ code: "BMS 740", title: "Advanced Topics", prerequisites: `${FIXES["BMS 740"].from} or BMS 999` }] }], 0)
  expect(changed.data.courses["BMS 740"].needs).toEqual({ text: `${FIXES["BMS 740"].from} or BMS 999` })
})

test("nothing is dropped: every course a sentence names is a course of its needs or in their text", () => {
  for (const { code, prerequisites } of all.filter(course => course.prerequisites && data.courses[course.code])) {
    const needs = data.courses[code].needs!
    const named = [...prerequisites!.matchAll(/\b[A-Z]{2,5} \d{3}[A-Z]{0,2}\b/g)].map(([code]) => code)
    const kept = [...coursesIn(needs), ...textsIn(needs).flatMap(text => [...text.matchAll(/\b[A-Z]{2,5} \d{3}[A-Z]{0,2}\b/g)].map(([code]) => code))]
    expect(new Set(kept)).toEqual(new Set(named))
  }
})

test("a course's needs name only courses in the catalog, the rest kept as text", () => {
  for (const { needs } of Object.values(data.courses))
    for (const code of needs ? coursesIn(needs) : [])
      expect(data.courses[code] ?? all.find(course => course.code === code)).toBeDefined()
  expect(coverage.dangling).toBeGreaterThan(0)
})

test("unlocks is exactly needs read backwards", () => {
  const isInverse = (courses: Prereqs["courses"]) => {
    for (const [code, { needs, unlocks = [] }] of Object.entries(courses)) {
      expect(unlocks).toEqual([...new Set(unlocks)].sort((a, b) => a.localeCompare(b, "en", { numeric: true })))
      for (const after of unlocks)
        expect(coursesIn(courses[after].needs!)).toContain(code)
      for (const before of needs ? coursesIn(needs) : [])
        expect(courses[before].unlocks).toContain(code)
    }
  }
  isInverse(data.courses)
  const code = fc.tuple(fc.constantFrom("CS", "IT", "MATH"), fc.integer({ min: 400, max: 420 })).map(([subject, number]) => `${subject} ${number}`)
  const tree: fc.Arbitrary<Req> = fc.oneof(code.map(course => ({ course })), fc.array(code.map(course => ({ course })), { minLength: 2, maxLength: 4 }).map(any => ({ any })))
  fc.assert(fc.property(fc.array(fc.tuple(code, tree)), entries => isInverse(withUnlocks(new Map(entries)))))
})

test("the file fits its schema and stays small", () => {
  expect(() => v.parse(Prereqs, data)).not.toThrow()
  expect(Object.values(data.courses).every(course => course.needs || course.unlocks?.length)).toBe(true)
})
