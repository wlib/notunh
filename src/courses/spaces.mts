// Finding a room to book from the one search field, as the map's search finds everything else: by its building, its
// number or what it's called ("Strafford Room"), how many it holds ("6 people", "for 6", "6+"), whether it's a study
// room, and whether it's free ("free now", "free at 3pm", "open at 3:30"). Whatever's left of what's typed once those
// are read names a building, by the gazetteer's name or an alias ("MUB", "Dimond"), then words of the room's number
// and name, fuzzily. And the room a page names, which may be the registrar's text for it ("Kingsbury N343", "Paul
// College Business&Econ 125") or ours ("Paul College 125")

import { type Space, type Standing, isFreeFor } from "./bookings.mts"
import { roomKey } from "./rooms.mts"
import { placeFinder } from "../social/aliases.mts"
import { fuzzySearch, latinize } from "../shared/fuzzy.mts"
import { addDays, atClock, localDay, nextAt } from "../shared/time.mts"

/** How many rooms a search lists */
const LIMIT = 8

/** Whether a room as the registrar or a page writes it, "Kingsbury N343", is a space: its number, after its building as the first words or all of them */
export const isSameRoom = (where: string, space: Pick<Space, "place" | "room">) => {
  const words = where.trim().split(/\s+/)
  const building = words.slice(0, -1).join(" ").toLowerCase()
  const place = space.place.toLowerCase()
  return words.at(-1)!.toUpperCase() === space.room.toUpperCase() && building !== "" && (place.startsWith(building) || building.startsWith(place))
}

/** The space a page's room is, by our name for it, else as the registrar writes it */
export const spaceFor = (spaces: readonly Space[], where: string) =>
  spaces.find(space => roomKey(space.where) === roomKey(where)) ?? spaces.find(space => isSameRoom(where, space))

/** What a search asks of a room: free at an instant, room for some people, a study room, any room, and the rest of what's typed */
export type Asked = { freeAt?: number, people?: number, isStudy?: boolean, isRoom?: boolean, words: string }

/** Whether a search asks anything of a room, rather than just naming something */
export const asksRooms = (asked: Asked) =>
  asked.freeAt !== undefined || asked.people !== undefined || Boolean(asked.isStudy || asked.isRoom)

/** An hour typed without AM or PM as a campus day means it: 8 to 11 in the morning, 12 to 7 after noon */
const hour24 = (hour: number, meridiem?: string) =>
  meridiem ? hour % 12 + (/^p/i.test(meridiem) ? 12 : 0) : hour >= 8 && hour <= 11 ? hour : hour % 12 + 12

const TIME   = /\b(?:free|open|available|empty)?\s*(?:at|@|from)\s+(\d{1,2})(?::(\d\d))?\s*([ap])?\.?m?\.?(?=\s|$)|\b(\d{1,2})(?::(\d\d))?\s*([ap])\.?m\.?(?=\s|$)/i
const NOW    = /\b(free|open|available|empty|vacant)(\s+(now|rooms?|spaces?))?\b/i
const PEOPLE = /\b(?:for\s+(\d{1,3})(?:\s+(?:people|persons?|ppl|of us))?|(\d{1,3})\s*(?:\+|people|persons?|ppl|seats?|or more)|seats?\s+(\d{1,3}))(?=\s|$)/i
const STUDY  = /\b(group\s+)?(study|collab(oration)?|alcove)(\s+(rooms?|spaces?|groups?))?\b/i
const ROOM   = /\b(rooms?|spaces?|conference|meeting\s+rooms?|classrooms?|to book|book(able)?|reserv(e|able))\b/i

/** What a search asks, read from what's typed at an instant: a time typed is its next on Durham's clock, or tomorrow's where it says so */
export const parseAsked = (query: string, now: number): Asked => {
  let words = ` ${query.trim()} `
  const take = (pattern: RegExp) => {
    const found = words.match(pattern)
    if (found)
      words = words.replace(found[0], " ")
    return found ?? undefined
  }
  const time = take(TIME)
  const isTomorrow = take(/\btomorrow\b/i)
  const isNow = take(NOW)
  const people = take(PEOPLE)
  const study = take(STUDY)
  const room = take(ROOM)
  const clock = time && `${String(hour24(+(time[1] ?? time[4]), time[3] ?? time[6])).padStart(2, "0")}:${time[2] ?? time[5] ?? "00"}`
  const freeAt = clock
    // A time this very minute is now's, not tomorrow's
    ? isTomorrow ? atClock(addDays(localDay(now), 1), clock) : nextAt(clock, now - 60_000)
    : isNow ? now : undefined
  return {
    ...freeAt !== undefined && { freeAt },
    ...people && { people: +(people[1] ?? people[2] ?? people[3]) },
    ...study && { isStudy: true },
    ...room && { isRoom: true },
    words: words.replace(/\s+/g, " ").trim()
  }
}

/** A space found, with how it stands at the time asked about */
export type FoundSpace = { space: Space, standing: Standing }

/** Finds the building some text names, by the gazetteer's name, a calendar's alias, or a hall's or library's first word ("Dimond"), and the text left */
const buildingFinder = (places: readonly string[]) => {
  const find = placeFinder(places, places.flatMap(place => /^\S+ (Hall|Library)$/.test(place) ? [[place.split(" ")[0], place] as const] : []))
  return (text: string): { place?: string, rest: string } => {
    const found = find(text)
    return found ? { place: found.place, rest: text.replace(found.found, " ").replace(/\s+/g, " ").trim() } : { rest: text }
  }
}

/**
 * Searches the spaces, given how each stands at an instant. A search that asks nothing of a room and names no room's
 * number or name finds none, so typing a building's name finds the building. Says how many rooms are as asked whether
 * or not they're free, so none free then differs from none at all
 */
export const createSpaceSearch = (spaces: readonly Space[]) => {
  const building = buildingFinder([...new Set(spaces.map(space => space.place))])
  const names = latinize(spaces.map(space => `${space.room || space.place} ${space.name ?? ""}`))

  return (query: string, now: number, standing: (space: Space, at: number) => Standing): { asked: Asked, found: FoundSpace[], matched: number } => {
    const asked = parseAsked(query, now)
    const at = asked.freeAt ?? now
    const { place, rest } = building(asked.words)
    const named = rest ? new Set(fuzzySearch(names, rest).map(({ index }) => index)) : undefined
    if (!asksRooms(asked) && !named?.size)
      return { asked, found: [], matched: 0 }
    const found = spaces.flatMap((space, i): FoundSpace[] =>
      (!place || space.place === place) &&
      (!named || named.has(i)) &&
      (!asked.isStudy || space.isStudy) &&
      (asked.people === undefined || (space.capacity ?? 0) >= asked.people)
        ? [{ space, standing: standing(space, at) }]
        : [])
    const isFree = ({ standing }: FoundSpace) => isFreeFor(standing, at)
    return {
      asked,
      matched: found.length,
      found: found
        .filter(item => asked.freeAt === undefined || isFree(item))
        // Free first, study rooms first, then the smallest that's big enough, then by name
        .sort((a, b) => +isFree(b) - +isFree(a) || +b.space.isStudy - +a.space.isStudy || (a.space.capacity ?? Infinity) - (b.space.capacity ?? Infinity) || a.space.where.localeCompare(b.space.where, "en", { numeric: true }))
        .slice(0, LIMIT)
    }
  }
}
export type SpaceSearch = ReturnType<typeof createSpaceSearch>
