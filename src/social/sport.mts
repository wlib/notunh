// What kind of thing an event is, as far as anyone looking for something to go to cares, read the same whatever
// calendar it came from: a game, meet or tournament anyone can come to, or a practice, a hold, a camp, a rehearsal,
// a tryout, which goes on there but isn't for going to; and the same game said by more than one calendar told once.
// Athletics' ICS, DSE Rec's club sports and 25Live each say some of the same things in their own words ("UNH Women's
// Ice Hockey vs Holy Cross", "Women's Ice Hockey game: Holy Cross"), so lists and the map go by this alone, never by
// a source. Nothing is dropped: a practice is gathered or drawn quieter, and an event told twice keeps the others'
// ids in `also`. Pure

import type { Event, Source } from "./event.mts"
import { groupBy } from "../shared/group.mts"
import { localDay } from "../shared/time.mts"

/** Words of a game or meet, which win over a practice's: "Camper Appreciation Night" is a hockey game's */
const GAME = /\bvs\.?\s|\bversus\b|\bgame\b|\bmeet\b|\bmatch\b|\btournament\b|\bscrimmage\b|\bplay day\b|\bregatta\b|\binvitational\b|\bchampionship/i
/** Words of a practice, or anything else booked but closed: a hold, a camp, a rehearsal, a tryout */
const PRACTICE = /\bpractices?\b|\brehears(al|als|ing)\b|\bhold\b|\bcamps?\b|\btraining\b|\btryouts?\b|\bclosed\b|\bconditioning\b|\blift(ing)?\b|\bwalk-?through\b|\bopen skate\b/i

/** Whether an event goes on there but isn't for going to: Athletics' never are, a person's own never is; else its title's words say */
export const isPractice = (event: Pick<Event, "title" | "source">) =>
  event.source !== "athletics" && event.source !== "pin" && !GAME.test(event.title) && PRACTICE.test(event.title)

//#region The same thing, told twice

/** Which calendar's telling of a thing is kept: the one surest of it */
const RANK: Record<Source, number> = { athletics: 0, "25live": 1, dserec: 2, rec: 3, presence: 4, pin: 5, course: 6 }

/** How far apart two tellings of one thing may start */
const NEAR_MS = 30 * 60_000

/** Words saying nothing of which game it is */
const FILLER = new Set(["unh", "vs", "versus", "game", "against", "the", "and", "at", "of", "home", "dii", "diii", "university", "new", "hampshire", "club"])

/** Words saying whose team plays, which two tellings of one game never differ in */
const TEAMS = ["men", "women", "boys", "girls"]

/** A title's words that say which thing it is: the sport, who's playing, and whose, "women's" as "women" */
const wordsOf = (title: string) =>
  new Set(title.toLowerCase().replace(/['’]s\b/g, "").split(/[^a-z0-9]+/).filter(word => word.length > 1 && !FILLER.has(word)))

/**
 * Whether two events from different calendars are one thing: at the same place, starting within half an hour, and
 * most of the shorter title's words in the other's, so "Women's Ice Hockey game: Holy Cross" is "UNH Women's Ice
 * Hockey vs Holy Cross - Post-Game Autographs", but men's isn't women's
 */
export const isSame = (a: Event, b: Event) => {
  if (a.source === b.source || !a.place || a.place !== b.place || Math.abs(a.start - b.start) > NEAR_MS)
    return false
  const [x, y] = [wordsOf(a.title), wordsOf(b.title)]
  if (TEAMS.some(team => x.has(team)) && TEAMS.some(team => y.has(team)) && !TEAMS.some(team => x.has(team) && y.has(team)))
    return false
  const [fewer, more] = x.size <= y.size ? [x, y] : [y, x]
  const shared = [...fewer].filter(word => more.has(word)).length
  return fewer.size > 0 && shared >= Math.max(2, Math.ceil(fewer.size * 0.75))
}

const rankOf = (event: Event) =>
  `${RANK[event.source]} ${event.id}`

/**
 * Events with each thing told once: every group of tellings that are the same, by isSame and what's the same as
 * that, kept as its surest, carrying the others' ids, and any they carried, in `also`. The same whatever order they
 * come in, and the same again run on its own answer
 */
export const deduped = (events: readonly Event[]): Event[] => {
  const parent = events.map((_, i) => i)
  const root = (i: number): number => parent[i] === i ? i : parent[i] = root(parent[i])
  // Only events near in time can be the same, so each is compared with those starting soon after it
  const order = events.map((_, i) => i).sort((a, b) => events[a].start - events[b].start)
  for (const [n, i] of order.entries())
    for (const j of order.slice(n + 1)) {
      if (events[j].start - events[i].start > NEAR_MS)
        break
      if (isSame(events[i], events[j]))
        parent[root(i)] = root(j)
    }
  return [...groupBy(events.keys(), root).values()].map(group => {
    const [kept, ...rest] = group.map(i => events[i]).sort((a, b) => rankOf(a).localeCompare(rankOf(b)))
    const also = [...new Set([...kept.also ?? [], ...rest.flatMap(event => [event.id, ...event.also ?? []])])].sort()
    return also.length ? { ...kept, also } : kept
  }).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
}

//#endregion

/** A list's line: an event, quieter if it's a practice, or a day's practices, gathered to say as one */
export type Line<E extends Event = Event> = { event: E, isMuted: boolean } | { practices: E[], place?: string }

/**
 * A list of events with each day's practices after the rest, gathered into one line where there's more than one, so
 * a list of what's on isn't a list of practices, and a lone practice takes no more room as its own row than as a line
 */
export const gathered = <E extends Event,>(events: readonly E[]): Line<E>[] => {
  const practices = groupBy(events.filter(isPractice), event => localDay(event.start))
  return [
    ...events.filter(event => !isPractice(event)).map(event => ({ event, isMuted: false })),
    ...[...practices.values()].map(practices => {
      if (practices.length === 1)
        return { event: practices[0], isMuted: true }
      const places = new Set(practices.map(event => event.place ?? event.where))
      return { practices, place: places.size === 1 ? [...places][0] : undefined }
    })
  ]
}
