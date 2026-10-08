// Which room is open, the favorites, every room's counts, and what the open room's machines are doing: reactive
// values only, no DOM

import { r, watch } from "bruh/reactive"
import usualUrl from "./usual.json?url"
import { ROOMS, pathOf, roomAtPath, roomName } from "./rooms.mts"
import { KINDS, assessRoom, type Kind, type RoomLive, type RoomSummary, type Summaries } from "./infer.mts"
import { emptyUsual, slotOf, unpack, type Usual, type Week } from "./model.mts"
import { getJson } from "../shared/json.mts"
import { poll } from "../shell/poll.mts"
import { now } from "../shell/lifecycle.mts"
import { distinct, remembered, toggled } from "../shell/state.mts"

// Each room answers from a 30 s cache, so polling the open one faster would only show the same answer, and every
// room's counts from a 5 minute one
const ROOM_POLL_MS = 30_000
const SUMMARIES_POLL_MS = 5 * 60_000

/** The hour of the week in Durham, reaching what depends on it only when it changes */
export const hourOfWeek = distinct(() => slotOf(now.value))

const isRoom = (id: unknown): id is string =>
  ROOMS.some(room => room.id === id)

export const favorites = remembered("laundry-favorites", stored => new Set(Array.isArray(stored) ? stored.filter(isRoom) : []), set => [...set])

export const toggleFavorite = (id: string) => {
  favorites.value = toggled(favorites.value, id)
}

//#region The open room, at its own path, so a favorite can be bookmarked or opened from the home screen

export const openRoom = r(roomAtPath(location.pathname))
addEventListener("popstate", () => openRoom.value = roomAtPath(location.pathname))

export const open = (id: string | undefined) => {
  openRoom.value = id
  history.pushState(null, "", pathOf(id))
  // Each view starts at its top, as a new page would
  scrollTo(0, 0)
}

watch([openRoom], () => {
  document.title = `${openRoom.value ? `${roomName(openRoom.value)} · ` : ""}Laundry · notunh`
})

//#endregion

//#region Live

/** Every room's counts as the collector last saw them, by id; empty until the first answer */
export const summaries = r<Summaries["rooms"]>({})
poll(async signal => summaries.value = (await getJson<Summaries>("/api/laundry/rooms", { signal })).rooms, SUMMARIES_POLL_MS)

/** Each room as last fetched live, by id; rooms not opened yet are missing */
export const rooms = r<Record<string, RoomLive>>({})
/** Whether the open room's last fetch failed */
export const isOpenFailed = r(false)

// Only the open room is asked for live, so a visit costs the vendor a request a room opened rather than one a room
watch([openRoom], () => {
  const id = openRoom.value
  isOpenFailed.value = false
  if (id)
    return poll(
      async signal => {
        rooms.value = { ...rooms.value, [id]: await getJson<RoomLive>(`/api/laundry/rooms/${encodeURIComponent(id)}`, { signal }) }
        isOpenFailed.value = false
      },
      ROOM_POLL_MS,
      error => {
        isOpenFailed.value = true
        console.error(error)
      }
    )
})

/** A room's counts: from its live answer while that's fresher than the collector's, else the collector's */
export const summaryOf = (id: string, at: number): RoomSummary | undefined => {
  const [live, summary] = [rooms.value[id], summaries.value[id]]
  return live && (!summary || live.at >= summary.at) ? assessRoom(live, at).summary : summary
}

//#endregion

//#region Usually

/** When each room is usually busy, learned nightly; empty until it loads, and if it can't */
export const usual = r<Usual>(emptyUsual())
getJson<Usual>(usualUrl).catch(emptyUsual).then(loaded => usual.value = loaded)

const unpacked = new WeakMap<Week, ReturnType<typeof unpack>>()

/** A room's usual week for a kind, by hour, with hours we know too little about undefined */
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
    .map(kind => usualWeek(id, kind)?.[slot]?.any)
    .filter(any => any !== undefined)
  if (!chances.length)
    return undefined
  const tightest = Math.min(...chances)
  return tightest >= QUIET ? "quiet" : tightest <= BUSY ? "busy" : undefined
}

//#endregion
