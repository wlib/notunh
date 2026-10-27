import { test, expect } from "vitest"
import fc from "fast-check"
import * as v from "valibot"
import { CoursesIndex, TermFile, activeTerms, emptyIndex, termOf } from "../../src/courses/course.mts"
import { candidates, publish } from "../../scripts/map/courses.mts"
import { addDays, atClock, localDay } from "../../src/shared/time.mts"
import { calendar, fall, jterm, spring } from "./fixtures.mts"

const imported = [fall, jterm, spring].map(({ code, name, fetched, sections }) => ({ code, name, fetched, sections }))

test("the terms fetched are those the calendar has running or starting within months, and published only where their sections agree", async () => {
  expect(candidates(calendar, atClock("2026-10-26", "12:00"))).toEqual(["202610", "202630", "202650"])
  expect(candidates(calendar, atClock("2027-01-20", "12:00"))).toEqual(["202630", "202650", "202670"])
  await fc.assert(fc.asyncProperty(fc.integer({ min: -30, max: 300 }), async offset => {
    const now = atClock(addDays(fall.from, offset), "12:00")
    const { index } = await publish(imported, calendar, now)
    // Every term live today is published, as is the next to start, and nothing published is over or months off
    for (const term of activeTerms([fall, jterm, spring], now))
      expect(index.terms.map(({ code }) => code)).toContain(term.code)
    const next = [fall, jterm, spring].filter(term => term.from > localDay(now) && term.from <= addDays(localDay(now), 150))[0]
    if (next)
      expect(index.terms.map(({ code }) => code)).toContain(next.code)
    expect(index.terms.every(term => term.to >= localDay(now) && term.from <= addDays(localDay(now), 150))).toBe(true)
  }), { numRuns: 40 })
})

test("the index names each live term's file by its content, carries the source's time apart from its own, and a page joins them back into the term", async () => {
  const now = atClock("2027-01-20", "12:00")
  const { index, files } = await publish(imported, calendar, now)
  expect(v.parse(CoursesIndex, index)).toEqual(index)
  expect(index.built).toBe(now)
  expect(index.files).toEqual(index.terms.map(({ file }) => file))
  for (const entry of index.terms) {
    expect(entry.file).toMatch(/^\/data\/courses\/[\w-]{16}\.json$/)
    const term = termOf(index, entry, v.parse(TermFile, JSON.parse(files.get(entry.file)!)))
    const source = [jterm, spring].find(({ code }) => code === entry.code)!
    expect(term.sections).toEqual(source.sections)
    expect(term.fetched).toBe(source.fetched)
    expect(term.built).toBe(now)
  }
  // The same sections publish to the same file whenever they're fetched
  const again = await publish(imported.map(term => ({ ...term, fetched: term.fetched + 1 })), calendar, now + 1)
  expect(again.index.files).toEqual(index.files)
  expect(v.parse(CoursesIndex, emptyIndex()).terms).toEqual([])
})

test("an address in the clear anywhere fails the publish", async () => {
  const leaked = { ...imported[0], sections: [{ ...fall.sections[0], title: "Write to someone@unh.edu" }, ...fall.sections.slice(1)] }
  await expect(publish([leaked], calendar, atClock("2026-10-26", "12:00"))).rejects.toThrow(/address/)
})
