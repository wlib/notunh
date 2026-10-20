// Which room is open, the favorites, every room's counts, and what the open room's machines are doing: reactive
// values only, no DOM

import { r, watch } from "bruh/reactive"
import { ROOMS, pathOf, roomAtPath, roomName } from "./rooms.mts"
import { KINDS, assessRoom, type Kind, type RoomLive, type RoomSummary, type Summaries } from "./infer.mts"
import { Usual, emptyUsual, slotOf, unpack, type Week } from "./model.mts"
import { getJson } from "../shared/json.mts"
import { type Live, live, poll } from "../shell/poll.mts"
import { latest } from "../shell/build.mts"
import { now } from "../shell/lifecycle.mts"
import { distinct, remembered, toggled } from "../shell/state.mts"

// Each room answers from a 30 s cache, so polling the open one faster would only show the same answer, and every
// room's counts from a 5 minute one
const ROOM_POLL_MS = 30_000
const SUMMARIES_POLL_MS = 5 * 60_000
/**
 * Counts older than this say when they were made, even while asking succeeds. The collector polls every 5 minutes
 * (15 overnight) and its answer is cached for 5, so counts only get this old once something has fallen behind
 */
export const COUNTS_FRESH_MS = 30 * 60_000

/** The hour of the week in Durham, reaching what depends on it only when it changes */
export const hourOfWeek = distinct(() => slotOf(now.value))

const isRoom = (id: unknown): id is string =>
  ROOMS.some(room => room.id === id)

export const favorites = remembered("laundry-favorites", stored => new Set(Array.isArray(stored) ? stored.filter(isRoom) : []), set => [...set])

export const toggleFavorite = (id: string) => {
  favorites.value = toggled(favorites.value, id)
}

//#region The open room, at its own path, so a favorite can be bookmarked or opened from the home screen

const pathname = r(location.pathname)
addEventListener("popstate", () => pathname.value = location.pathname)

export const openRoom = r(() => roomAtPath(pathname.value))
/** Whether the path is a room's that there's no such room for, which the service worker serves this page for too */
export const isUnknownRoom = r(() => openRoom.value === undefined && pathname.value !== "/laundry/")

export const open = (id: string | undefined) => {
  history.pushState(null, "", pathOf(id))
  pathname.value = pathOf(id)
  // Each view starts at its top, as a new page would
  scrollTo(0, 0)
}

watch([openRoom], () => {
  document.title = `${openRoom.value ? `${roomName(openRoom.value)} · ` : ""}Laundry · notunh`
})

//#endregion

//#region Live

/** Every room's counts as the collector last saw them, as last answered, and how asking for them is going */
export const counted = live<Summaries>()
poll(signal => getJson<Summaries>("/api/laundry/rooms", { signal }), SUMMARIES_POLL_MS, state => counted.value = state)
/** Every room's counts, by id; empty until the first answer */
export const summaries = r(() => counted.value.value?.rooms ?? {})

/** Each room as last fetched live, by id, and how asking for it is going; rooms not opened yet are missing */
export const rooms = r<Record<string, Live<RoomLive>>>({})

// Only the open room is asked for live, so a visit costs the vendor a request a room opened rather than one a room.
// What an earlier visit to the room learned stays its evidence until a newer answer comes
watch([openRoom], () => {
  const id = openRoom.value
  if (id)
    return poll(signal => getJson<RoomLive>(`/api/laundry/rooms/${encodeURIComponent(id)}`, { signal }), ROOM_POLL_MS, state => {
      rooms.value = { ...rooms.value, [id]: { ...rooms.value[id], ...state } }
    })
})

/** A room's counts: from its live answer while that's fresher than the collector's, else the collector's */
export const summaryOf = (id: string, at: number): RoomSummary | undefined => {
  const [room, summary] = [rooms.value[id]?.value, summaries.value[id]]
  return room && (!summary || room.at >= summary.at) ? assessRoom(room, at).summary : summary
}

//#endregion

//#region Usually

/** When each room is usually busy, learned nightly, and swapped for a newer build's as it comes; empty until it loads */
export const usual = await latest("usual", Usual, emptyUsual)

const unpacked = new WeakMap<Week, ReturnType<typeof unpack>>()

/** A room's usual week for a kind, by hour, each leaning on the room's usual at any hour, or nothing for a room never watched */
export const usualWeek = (id: string, kind: Kind) => {
  const week = usual.value.rooms[id]?.[kind]
  if (week && !unpacked.has(week))
    unpacked.set(week, unpack(week))
  return week && unpacked.get(week)
}

// Any free this share of the hour or more is usually quiet, and this or less usually busy
const QUIET = 0.8
const BUSY = 0.4

/** "quiet" or "busy" when a room usually is in an hour of the week, going by whichever kind is tighter */
export const usually = (id: string, slot: number) => {
  const chances = KINDS
    .map(kind => usualWeek(id, kind)?.[slot].any)
    .filter(any => any !== undefined)
  if (!chances.length)
    return undefined
  const tightest = Math.min(...chances)
  return tightest >= QUIET ? "quiet" : tightest <= BUSY ? "busy" : undefined
}

//#endregion
