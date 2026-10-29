// The map's rooms (src/map/state/rooms.mts): what's known opens from the build's week, the Worker's day is merged
// over it, a room asked about afresh wins over a day's answer cached longer, classes count as busy, and asking is
// throttled whether it answers or fails, until verifying asks afresh

import { test, expect, vi, beforeEach } from "vitest"
import { r } from "bruh/reactive"
import type { Booked, RoomsData, Space } from "../../src/courses/bookings.mts"
import type { Courses } from "../../src/courses/browser/terms.mts"
import { atClock } from "../../src/shared/time.mts"

const asked: { day: string, space?: string }[] = []
let answer: (day: string, space?: string) => Promise<Booked | undefined>

vi.mock("../../src/social/browser/api.mts", () => ({
  bookedOn: (day: string, space?: string) => {
    asked.push({ day, ...space !== undefined && { space } })
    return answer(day, space)
  }
}))

const { createRooms } = await import("../../src/map/state/rooms.mts")

const DAY = "2026-10-28"
const at = (time: string) => atClock(DAY, time)
const DIMOND: Space = { id: "532", source: "25live", where: "Dimond Library 121", place: "Dimond Library", room: "121", capacity: 5, isStudy: true }
const KINGSBURY: Space = { id: "400", source: "25live", where: "Kingsbury Hall N343", place: "Kingsbury Hall", room: "N343", capacity: 71, isStudy: false }
const meeting = (space: string, from: string, to: string) => ({ space, start: at(from), end: at(to), type: "Meeting" })

const SNAPSHOT: RoomsData = { fetched: 1, spaces: [DIMOND, KINGSBURY], days: [{ day: DAY, fetched: 1, bookings: [meeting("532", "09:00", "10:00")] }] }

/** A class in Kingsbury N343 from 11 to noon, as the courses' schedule would say it */
const courses = {
  schedule: {
    roomsIn: (place: string) => place === "Kingsbury Hall" ? ["Kingsbury N343"] : [],
    on: ({ room }: { room: string }) => room === "Kingsbury N343" ? [{ event: { start: at("11:00"), end: at("12:00") } }] : []
  }
} as unknown as Courses

const flush = () => new Promise(resolve => setTimeout(resolve))

const rooms = () =>
  createRooms({ rooms: r(SNAPSHOT), courses: r<Courses | undefined>(courses) }, () => {})

beforeEach(() => {
  asked.length = 0
  answer = async () => undefined
})

test("a room opens from the build's week, then takes the Worker's newer day, and a room asked since stays newer", async () => {
  const state = rooms()
  // Learned as the state starts, once bruh flushes
  await flush()
  expect(state.roomsOn(DAY).bookings).toEqual([meeting("532", "09:00", "10:00")])
  expect(state.roomStanding(DIMOND, at("09:30"))).toEqual({ isFree: false, until: at("10:00") })

  answer = async (day, space) => space === undefined
    ? { day, fetched: 10, bookings: [meeting("532", "13:00", "14:00"), meeting("400", "08:00", "09:00")] }
    : { day, fetched: 20, bookings: [meeting("532", "15:00", "16:00")] }
  state.refreshRoom(DIMOND, DAY)
  await flush()
  state.wantRooms(DAY)
  await flush()
  // The room's own answer is newer than the day's, so the day's says nothing of it
  expect(state.roomsOn(DAY).bookings.filter(({ space }) => space === "532")).toEqual([meeting("532", "15:00", "16:00")])
  expect(state.roomsOn(DAY).bookings.filter(({ space }) => space === "400")).toEqual([meeting("400", "08:00", "09:00")])
  expect(state.roomStanding(DIMOND, at("09:30"))).toEqual({ isFree: true, until: at("15:00") })
})

test("a room the registrar schedules classes in is busy with them too", () => {
  const state = rooms()
  expect(state.registrarRoom(KINGSBURY)).toBe("Kingsbury N343")
  expect(state.registrarRoom(DIMOND)).toBeUndefined()
  expect(state.roomStanding(KINGSBURY, at("11:30"))).toEqual({ isFree: false, until: at("12:00") })
  expect(state.roomStanding(KINGSBURY, at("10:30"))).toEqual({ isFree: true, until: at("11:00") })
})

test("a day or a room is asked about once in a while, failing or not, and afresh once that's asked for", async () => {
  const state = rooms()
  answer = () => Promise.reject(new TypeError("Load failed"))
  state.wantRooms(DAY)
  state.wantRooms(DAY)
  state.refreshRoom(DIMOND, DAY)
  state.refreshRoom(DIMOND, DAY)
  await flush()
  state.wantRooms(DAY)
  await flush()
  expect(asked).toEqual([{ day: DAY }, { day: DAY, space: "532" }])
  expect(state.roomsOn(DAY).bookings).toEqual([meeting("532", "09:00", "10:00")])
  state.askAfresh()
  state.wantRooms(DAY)
  expect(asked).toHaveLength(3)
})
