// Finding a room to book (src/courses/spaces.mts): what's asked of a room in what's typed, the rooms found for it,
// and which space a page's room is, by our name for it or the registrar's

import { test, expect } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import { type RoomsData, type Standing, isFreeFor } from "../../src/courses/bookings.mts"
import { createSpaceSearch, isSameRoom, parseAsked, spaceFor } from "../../src/courses/spaces.mts"
import { addDays, atClock } from "../../src/shared/time.mts"

const { spaces }: RoomsData = JSON.parse(await readFile(new URL("../fixtures/data/src/map/rooms.json", import.meta.url), "utf8"))
const search = createSpaceSearch(spaces)

/** Ten in the morning on the fixtures' day, so a time later in the day is that day's */
const DAY = "2026-10-28"
const NOW = atClock(DAY, "10:00")
const always: (space: unknown, at: number) => Standing = () => ({ isFree: true })

test("what's typed asks for a time, a size, a study room, or a room at all, and the rest is words", () => {
  expect(parseAsked("study room free now", NOW)).toEqual({ freeAt: NOW, isStudy: true, words: "" })
  expect(parseAsked("Dimond 6 people", NOW)).toEqual({ people: 6, words: "Dimond" })
  expect(parseAsked("room for 4 at the MUB", NOW)).toMatchObject({ people: 4, isRoom: true })
  expect(parseAsked("free at 3pm", NOW)).toEqual({ freeAt: atClock(DAY, "15:00"), words: "" })
  expect(parseAsked("free at 3", NOW).freeAt).toBe(atClock(DAY, "15:00"))
  expect(parseAsked("open at 11:30", NOW).freeAt).toBe(atClock(DAY, "11:30"))
  expect(parseAsked("group study 8+", NOW)).toEqual({ people: 8, isStudy: true, words: "" })
  // A time already past is tomorrow's
  expect(parseAsked("free at 9am", NOW).freeAt).toBe(atClock(addDays(DAY, 1), "09:00"))
  expect(parseAsked("free at 3pm tomorrow", NOW)).toEqual({ freeAt: atClock(addDays(DAY, 1), "15:00"), words: "" })
  expect(parseAsked("Strafford Room", NOW)).toEqual({ isRoom: true, words: "Strafford" })
  expect(parseAsked("Kingsbury N343", NOW)).toEqual({ words: "Kingsbury N343" })
})

test("rooms are found by building, size and kind, study rooms then the smallest big enough first, and a building's name alone finds none", () => {
  const dimond = search("Dimond 6 people", NOW, always).found
  expect(dimond.length).toBeGreaterThan(0)
  expect(dimond.every(({ space }) => space.place === "Dimond Library" && space.capacity! >= 6)).toBe(true)
  expect(dimond.map(({ space }) => space)).toEqual(dimond.map(({ space }) => space).toSorted((a, b) => +b.isStudy - +a.isStudy || a.capacity! - b.capacity!))
  const study = search("study room", NOW, always).found
  expect(study).toHaveLength(8)
  expect(study.every(({ space }) => space.isStudy)).toBe(true)
  expect(search("Strafford", NOW, always).found.map(({ space }) => space.where)).toEqual(["Memorial Union Building 240"])
  expect(search("MUB 330", NOW, always).found[0].space.where).toBe("Memorial Union Building 330")
  expect(search("Dimond", NOW, always).found).toEqual([])
  // Campus Rec's courts and fields, by what they are
  expect(search("Hamel court free now", NOW, always).found.map(({ space }) => space.room)).toEqual(expect.arrayContaining(["Court 1 (3rd Floor)", "Court 2 (3rd Floor)", "Court 3 (3rd Floor)"]))
  expect(search("field free now", NOW, always).found.map(({ space }) => space.where)).toEqual(expect.arrayContaining(["Bremner Field", "Memorial Field", "Student Rec Field"]))
})

test("asked free at a time, only rooms free then for a while are found, and the free ones come first otherwise", () => {
  const busy = new Set(spaces.filter(space => space.isStudy).slice(0, 3).map(space => space.id))
  const standing = (space: { id: string }, at: number): Standing => busy.has(space.id) ? { isFree: false, until: at + 3_600_000 } : { isFree: true }
  const free = search("study room free at 3pm", NOW, standing)
  expect(free.asked.freeAt).toBe(atClock(DAY, "15:00"))
  expect(free.found.length).toBeGreaterThan(0)
  expect(free.found.some(({ space }) => busy.has(space.id))).toBe(false)
  expect(search("study room free at 3pm", NOW, () => ({ isFree: false, until: NOW + 86_400_000 }))).toMatchObject({ found: [], matched: spaces.filter(space => space.isStudy).length })
  expect(search("Dimond qqqqq free at 3pm", NOW, standing).matched).toBe(0)
  const any = search("study room", NOW, standing).found
  const firstBusy = any.findIndex(({ standing }) => !standing.isFree)
  expect(firstBusy === -1 || any.slice(firstBusy).every(({ standing }) => !standing.isFree)).toBe(true)
})

test("whatever's typed, what's found is a few rooms, each as the search asked", () => {
  const word = fc.constantFrom("free", "now", "at", "3pm", "study", "room", "for", "6", "people", "Dimond", "MUB", "Kingsbury", "121", "Strafford", "group", "+", "the")
  fc.assert(fc.property(fc.array(word, { maxLength: 6 }), words => {
    const { asked, found } = search(words.join(" "), NOW, always)
    expect(found.length).toBeLessThanOrEqual(8)
    for (const { space, standing } of found) {
      if (asked.isStudy)
        expect(space.isStudy).toBe(true)
      if (asked.people !== undefined)
        expect(space.capacity).toBeGreaterThanOrEqual(asked.people)
      if (asked.freeAt !== undefined)
        expect(isFreeFor(standing, asked.freeAt)).toBe(true)
    }
  }))
})

test("a page's room is a space by our name for it, or as the registrar writes it", () => {
  expect(spaceFor(spaces, "Dimond Library 121")?.id).toBe("532")
  expect(spaceFor(spaces, "dimond  library 121")?.id).toBe("532")
  expect(spaceFor(spaces, "Kingsbury N343")?.where).toBe("Kingsbury Hall N343")
  expect(spaceFor(spaces, "Paul College Business&Econ 125")?.where).toBe("Paul College 125")
  expect(spaceFor(spaces, "Hamilton Smith 102")?.where).toBe("Hamilton Smith Hall 102")
  expect(spaceFor(spaces, "Kingsbury N999")).toBeUndefined()
  expect(spaceFor(spaces, "N343")).toBeUndefined()
  // Paul College's 125 isn't the arts center's
  expect(isSameRoom("Paul Creative Arts Center 125", { place: "Paul College", room: "125" })).toBe(false)
})
