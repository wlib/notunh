// What happens again and again, told once: a club's weekly meeting, a Campus Rec class, a sport club's practices, a
// curated series. Each event of one is a session of a series, known by a key read from its id or its link, so a list
// folds what recurs under what's on once, an activity is followed by its key (saves.mts), and the directory lists each
// with when it meets and what's next. A game, a talk, a booking or a person's own event is no series. Pure

import type { Event, Org } from "./event.mts"
import { slugIn } from "./curated.mts"
import { isPractice } from "./sport.mts"
import { getOrCreate, groupBy } from "../shared/group.mts"
import { type Day, addDays, localDay, localMinutes, weekday } from "../shared/time.mts"

export type Kind = "club" | "rec" | "practice" | "curated"

export type SeriesOf = { key: string, kind: Kind, name: string }

/** A club's meeting, as Wildcat Link's clubs say: presence:<club>/meeting/<day> */
const MEETING = /^presence:(.+)\/meeting\/\d{4}-\d\d-\d\d$/

/** A Campus Rec program, by its page, which each of its sessions links to */
const PROGRAM = /[?&]courseId=([\w-]+)/

/** A sport club, by its events page */
const CLUB = /\/club\/(\d+)\//

/** The series an event is a session of, or none for a one-off, a sport club's game among them */
export const seriesOf = (event: Pick<Event, "id" | "source" | "url" | "title">): SeriesOf | undefined => {
  const club = event.id.match(MEETING)?.[1]
  if (club)
    return { key: `presence:${club}`, kind: "club", name: event.title.replace(/ meeting$/, "") }
  const program = event.source === "rec" ? event.url.match(PROGRAM)?.[1] : undefined
  if (program)
    return { key: `rec:${program}`, kind: "rec", name: event.title }
  const team = event.source === "dserec" && isPractice(event) ? event.url.match(CLUB)?.[1] : undefined
  if (team)
    return { key: `dserec:${team}`, kind: "practice", name: event.title.split(":")[0] }
  const slug = event.source === "curated" ? slugIn(event.id) : undefined
  if (slug)
    return { key: `curated:${slug}`, kind: "curated", name: event.title }
}

export const INTERESTS = ["Fitness", "Sports", "Arts", "Culture & faith", "Academic & career", "Service & advocacy", "Hobbies", "Greek life", "Halls & government", "Other"] as const
export type Interest = typeof INTERESTS[number]

/** Wildcat Link's categories, as its clubs are tagged, each as the interest it is */
const CATEGORIES: Record<string, Interest> = {
  "Arts & Performance":                                         "Arts",
  "Media & Publications":                                       "Arts",
  "Culture & Identity":                                         "Culture & faith",
  "Religious & Spiritual":                                      "Culture & faith",
  "Academic & Career":                                          "Academic & career",
  "CEPS":                                                       "Academic & career",
  "Graduate":                                                   "Academic & career",
  "Professional Fraternities and Sororities & Honor Societies": "Academic & career",
  "Community Service":                                          "Service & advocacy",
  "Activism, Advocacy, & Political":                            "Service & advocacy",
  "Sport Clubs":                                                "Sports",
  "Recreational Sport Club":                                    "Sports",
  "Special Interest":                                           "Hobbies",
  "Social Fraternities & Sororities":                           "Greek life",
  "Residence Hall Councils":                                    "Halls & government",
  "Student Governance":                                         "Halls & government"
}

/** Words of a name, for a series no club's categories say: Campus Rec's classes, sport clubs' practices, UNH's pages */
const WORDS: [Interest, RegExp][] = [
  ["Sports",          /hockey|soccer|volleyball|softball|baseball|tennis|rugby|lacrosse|\bski|judo|woodsmen|climb|skat|puck|ultimate|frisbee|fencing|sailing|rowing|karate|boxing|wrestling|basketball|swim/i],
  ["Fitness",         /yoga|pilates|barre|zumba|cycling|cardio|kickboxing|hiit|strength|core\b|pump|spin|bootcamp|aqua|fitness/i],
  ["Arts",            /danc|music|band|choir|cappella|improv|comedy|theat|film|\bart|orchestra|jazz/i],
  ["Culture & faith", /conversation|tea hour|caf[eé]|language|cultur/i]
]

/** Each kind's interest where neither its club's categories nor its name says one */
const BY_KIND: Record<Kind, Interest> = { club: "Other", rec: "Fitness", practice: "Sports", curated: "Culture & faith" }

export const interestOf = ({ kind, name }: SeriesOf, categories: readonly string[] = []): Interest =>
  categories.map(category => CATEGORIES[category]).find(Boolean) ?? WORDS.find(([, words]) => words.test(name))?.[0] ?? BY_KIND[kind]

export type Join = "drop-in" | "sign-up" | "team" | "ask"

/** How to join, as far as the data says: a Campus Rec class with spots is signed up for, and a club is its organizer's to say */
export const joinOf = (kind: Kind, sessions: readonly Pick<Event, "left">[]): Join =>
  kind === "curated"  ? "drop-in" :
  kind === "practice" ? "team" :
  kind === "club"     ? "ask" :
  sessions.some(({ left }) => left !== undefined) ? "sign-up" : "drop-in"

const HOSTS: Record<Kind, string> = { club: "Wildcat Link club", rec: "Campus Recreation", practice: "UNH Club Sports", curated: "UNH's website" }

/** An activity as the directory lists it */
export type Listing = SeriesOf & {
  interest: Interest
  join:     Join
  host:     string
  url:      string
  place?:   string
  where:    string
  /** Weekdays it meets on, 0 for Monday */
  days:     number[]
  /** How many times of day it starts at, so one at many is said to vary */
  times:    number
  /** Its sessions still to come, soonest first; none for a club that's posted no time to meet */
  sessions: Event[]
  /** What its club's page says of meeting, as words */
  meets?:   string
}

const patternOf = (sessions: readonly Pick<Event, "start">[]) => ({
  days:  [...new Set(sessions.map(({ start }) => weekday(localDay(start))))].sort(),
  times: new Set(sessions.map(({ start }) => localMinutes(start))).size
})

/** The week a day is in, by its Monday, so sessions in two weeks are a series and two days in one aren't */
const weekOf = (day: Day) =>
  addDays(day, -weekday(day))

/**
 * Whether a series' sessions make it recur: a club's meeting always does, as its page says it's weekly; anything else
 * once it's on in two weeks or more, so two days of one fair aren't a series to browse
 */
export const recurs = (kind: Kind, sessions: readonly Pick<Event, "start">[]) =>
  kind === "club" || new Set(sessions.map(({ start }) => weekOf(localDay(start)))).size > 1

/**
 * Every activity, by name: each series that recurs with sessions to come, and every other club Wildcat Link lists,
 * with none. The one test of what's an activity: only what's listed here is followed, folded or told once in search
 */
export const directory = (events: readonly Event[], orgs: readonly Org[], now: number): Listing[] => {
  const byKey = new Map(orgs.map(org => [org.key, org]))
  const listed = [...groupBy(events.flatMap(event => {
    const series = seriesOf(event)
    return series ? [{ series, event }] : []
  }), ({ series }) => series.key).values()]
    .flatMap((group): Listing[] => {
      const [{ series }] = group
      const all = group.map(({ event }) => event)
      const sessions = all.filter(event => event.end > now).sort((a, b) => a.start - b.start)
      if (!sessions.length || !recurs(series.kind, all))
        return []
      const [first] = sessions
      const org = byKey.get(series.key)
      return [{
        ...series, ...org && { name: org.name },
        interest: interestOf(series, org?.categories), join: joinOf(series.kind, sessions), host: HOSTS[series.kind], url: org?.url ?? first.url,
        place: first.place, where: first.where, ...patternOf(sessions), sessions
      }]
    })
  const keys = new Set(listed.map(({ key }) => key))
  const unposted = orgs.filter(org => !keys.has(org.key)).map((org): Listing => {
    const series: SeriesOf = { key: org.key, kind: "club", name: org.name }
    return { ...series, interest: interestOf(series, org.categories), join: "ask", host: HOSTS.club, url: org.url, where: org.where ?? "", days: [], times: 0, sessions: [], ...org.meets && { meets: org.meets } }
  })
  return [...listed, ...unposted].sort((a, b) => a.name.localeCompare(b.name, "en"))
}

/** What a list folds into one line that opens, in the order they're listed */
export const FOLDS = ["club", "rec", "practice"] as const
export type FoldKind = typeof FOLDS[number]

export type Fold<E extends Event = Event> = { fold: FoldKind, events: E[] }

/**
 * A list's rows and folds: one-offs, curated sessions and what's yours as rows, then each kind of what recurs as one
 * fold. A practice always folds, a series' or not, as it's not for going to. Nothing is dropped
 */
export const folded = <E extends Event>(events: readonly E[], isRecurring: (key: string) => boolean, isYours: (event: E) => boolean) => {
  const foldOf = (event: E): FoldKind | undefined => {
    if (isYours(event))
      return
    const series = seriesOf(event)
    if (isPractice(event))
      return "practice"
    if (series && series.kind !== "curated" && series.kind !== "practice" && isRecurring(series.key))
      return series.kind
  }
  const rows: E[] = []
  const folds = new Map<FoldKind, E[]>()
  for (const event of events) {
    const fold = foldOf(event)
    if (fold)
      getOrCreate(folds, fold, () => []).push(event)
    else
      rows.push(event)
  }
  return { rows, folds: FOLDS.flatMap((fold): Fold<E>[] => folds.has(fold) ? [{ fold, events: folds.get(fold)! }] : []) }
}
