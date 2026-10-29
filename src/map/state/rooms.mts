// The rooms to book on the map: the spaces and the week's bookings the build bundled, and the Worker's newer word
// merged over them as it comes (src/courses/bookings.mts), so a room's page and search answer at once from whatever's
// known and change in place as more is: a day as a page or search wants it, and one room afresh as its page opens or
// someone goes to reserve it. Campus Rec's facilities are known from the build's week alone, which the Worker's
// answers, of 25Live's rooms, never cover. What's busy in a room is its bookings, those of the space it's within, and
// where the registrar schedules classes there, its classes. Asked as this device, so a verified one hears titles.
// Reactive values only, no DOM

import { type Reactive, r, watch } from "bruh/reactive"
import { type Booked, type Known, type RoomsData, type Space, type Span, UNKNOWN, bookingsOf, learned, standingAt } from "../../courses/bookings.mts"
import { createSpaceSearch, isSameRoom } from "../../courses/spaces.mts"
import type { Courses } from "../../courses/browser/terms.mts"
import { bookedOn } from "../../social/browser/api.mts"
import { type Day, localDay } from "../../shared/time.mts"
import type { Own } from "../../shell/state.mts"

/** How soon a day, or one room, is asked about again, as the Worker shares a day's answer for ten minutes and a room's for 30 s */
const DAY_AGAIN_MS  = 5 * 60_000
const ROOM_AGAIN_MS = 30_000

export const createRooms = ({ rooms, courses }: { rooms: Reactive<RoomsData>, courses: Reactive<Courses | undefined> }, own: Own) => {
  const spaces = r(() => rooms.value.spaces)
  /** The spaces the Worker's answers cover, 25Live's */
  const live = r(() => spaces.value.filter(space => space.source === "25live").map(space => space.id))
  const searchSpaces = r(() => createSpaceSearch(spaces.value))

  /** What's known of each day so far */
  const known = r(new Map<Day, Known>())
  const learn = (booked: Booked, covers: readonly string[]) => {
    const before = known.peek().get(booked.day) ?? UNKNOWN
    const after = learned(before, booked, covers)
    if (after !== before)
      known.value = new Map(known.peek()).set(booked.day, after)
  }
  // The build's week, and a newer build's as it comes, beneath anything newer already heard
  own(watch([rooms], () => rooms.value.days.forEach(booked => learn(booked, rooms.value.spaces.map(space => space.id)))))

  /** When each day, and each room on a day, was last asked about, answered or not, so offline a search doesn't ask on every keystroke */
  const asked = new Map<string, number>()
  const askOnce = (day: Day, space: string | undefined, again: number) => {
    const key = `${day}/${space ?? ""}`
    if (Date.now() - (asked.get(key) ?? -Infinity) < again)
      return
    asked.set(key, Date.now())
    bookedOn(day, space).then(booked => booked && learn(booked, space === undefined ? live.peek() : [space]), () => {})
  }

  /** Asks the Worker about a day, unless it was asked lately */
  const wantRooms = (day: Day) =>
    askOnce(day, undefined, DAY_AGAIN_MS)

  /** Asks the Worker about one of 25Live's rooms on a day afresh, as someone looks into it or goes to book it */
  const refreshRoom = (space: Space, day: Day) => {
    if (space.source === "25live")
      askOnce(day, space.id, ROOM_AGAIN_MS)
  }

  /** Forgets what's been asked, so the next look asks again, as once this device's email is verified it's told more */
  const askAfresh = () =>
    asked.clear()

  /** What's known of a day, followed */
  const roomsOn = (day: Day) =>
    known.value.get(day) ?? UNKNOWN

  /** The registrar's name for each space it schedules classes in, once the courses are loaded */
  const registrarRooms = r(() => {
    const schedule = courses.value?.schedule
    return new Map(schedule ? spaces.value.flatMap(space => {
      const where = schedule.roomsIn(space.place).find(where => isSameRoom(where, space))
      return where ? [[space.id, where] as const] : []
    }) : [])
  })
  const registrarRoom = (space: Space) =>
    registrarRooms.value.get(space.id)

  /** What's busy in a space on a day, its bookings and those of the space it's within, and its classes, followed */
  const busyIn = (space: Space, day: Day): Span[] => {
    const where = registrarRoom(space)
    return [
      ...bookingsOf(roomsOn(day).bookings, space),
      ...where ? courses.value!.schedule.on({ room: where }, day).map(({ event }) => event) : []
    ]
  }

  /** How a space stands at an instant, followed */
  const roomStanding = (space: Space, at: number) =>
    standingAt(busyIn(space, localDay(at)), at)

  return { spaces, searchSpaces, roomsOn, wantRooms, refreshRoom, askAfresh, registrarRoom, roomStanding }
}
