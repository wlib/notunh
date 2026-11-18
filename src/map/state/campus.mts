// What the campus is doing now, for the sheet's Campus view and the pages it leads to (ui/Campus.tsx): each dining
// hall's standing and the meal it's serving, read from today's menu file once something shows it, and every laundry
// room's counts as the Worker's collector last saw them, asked for only while something shows them. The
// laundry rooms you've starred are the laundry page's own, remembered under the same key, so either side follows the
// other. Reactive values only, no DOM

import { r, watch, type DerivativeNode } from "bruh/reactive"
import { type Status, status } from "../../dining/hours.mts"
import { type Hall, type Meal, fileUrl } from "../../dining/menus.mts"
import type { RoomSummary, Summaries } from "../../laundry/infer.mts"
import { ROOMS } from "../../laundry/rooms.mts"
import type { Room } from "../../laundry/upstream.mts"
import type { Building } from "../../places/buildings.mts"
import { arrayOf, getJson } from "../../shared/json.mts"
import { slug } from "../../shared/slug.mts"
import { localDay, localHour, localMinutes } from "../../shared/time.mts"
import { jsonOf, loadImmutable } from "../../shell/load.mts"
import { live, poll } from "../../shell/poll.mts"
import { type Own, distinct, remembered, toggled } from "../../shell/state.mts"
import type { MapData } from "./data.mts"

// The collector's counts are cached for 5 minutes, so asking sooner would only hear the same answer
const COUNTS_POLL_MS = 5 * 60_000

const MEALS = jsonOf(arrayOf<Meal>())

/** The meal a clock hour is for, as the dining page opens on it (src/dining/state.mts) */
export const mealAt = (hour: number) =>
  hour < 10 ? "breakfast" : hour < 15 ? "lunch" : "dinner"

/** A hall now: whether it's open and till when, and the meal it's serving or serves next, once today's menu has loaded */
export type HallNow = Hall & { standing?: Status, meal?: Meal }

/** A laundry room with the building it's in, which the map marks */
export type Laundry = { room: Room, building?: Building }

const isRoom = (id: unknown): id is string =>
  ROOMS.some(room => room.id === id)

export const createCampus = ({ menus, buildings, now }: Pick<MapData, "menus" | "buildings"> & { now: DerivativeNode<number> }, own: Own) => {
  /** Whether anything shows the halls' meals or the rooms' counts yet, so a visit that never looks costs nothing */
  const wantsMeals = r(false)
  const wantsCounts = r(false)

  /** Durham's clock to the minute, so what follows it is made again no oftener */
  const minute = distinct(() => Math.floor(now.value / 60))
  const day = distinct(() => localDay(minute.value * 60_000))

  /** Each hall's meals today, by hall, as they load */
  const served = r<Record<string, Meal[]>>({})
  own(watch(() => {
    if (!wantsMeals.value)
      return
    const loading = new AbortController()
    for (const hall of menus.value.halls) {
      const file = menus.value.days[hall.id]?.[day.value]?.file
      if (file)
        void loadImmutable(fileUrl(file), MEALS, { signal: loading.signal }).then(meals => served.value = { ...served.value, [hall.id]: meals }, () => {})
    }
    return () => loading.abort()
  }))

  /** Each hall now, once asked for */
  const halls = r((): HallNow[] => {
    const at = minute.value * 60_000
    const wanted = mealAt(localHour(at))
    return menus.value.halls.map(hall => {
      const hours = menus.value.hours[hall.id]
      const meals = served.value[hall.id] ?? []
      return {
        ...hall,
        standing: hours && status(hours, { day: localDay(at), minute: localMinutes(at) }),
        meal:     meals.find(({ meal }) => meal === wanted) ?? meals.find(({ meal }) => meal === "brunch") ?? meals.at(-1)
      }
    })
  })

  /** Every laundry room's counts, as last answered, and how asking is going */
  const counted = live<Summaries>()
  own(watch([wantsCounts], () => {
    if (wantsCounts.value)
      return poll(signal => getJson<Summaries>("/api/laundry/rooms", { signal }), COUNTS_POLL_MS, state => counted.value = state)
  }))

  /** The rooms starred, as the laundry page stars them */
  const starred = remembered("laundry-favorites", stored => new Set(Array.isArray(stored) ? stored.filter(isRoom) : []), set => [...set])

  /** Every laundry room with its building, those starred first */
  const laundry = r((): Laundry[] =>
    ROOMS
      .map(room => ({ room, building: buildings.value.find(building => building.rooms?.includes(slug(room.name))) }))
      .sort((a, b) => +starred.value.has(b.room.id) - +starred.value.has(a.room.id))
  )

  return {
    /** Asks for today's menus, as something shows the halls' meals */
    wantMeals: () => wantsMeals.value = true,
    /** Starts asking for the rooms' counts, as something shows them */
    wantCounts: () => wantsCounts.value = true,
    hallsNow: halls,
    laundryCounts: counted,
    /** A room's counts, where they've been heard */
    countsOf: (id: string): RoomSummary | undefined => counted.value.value?.rooms[id],
    laundry,
    starredRooms: starred,
    toggleStarred: (id: string) => starred.value = toggled(starred.value, id)
  }
}
