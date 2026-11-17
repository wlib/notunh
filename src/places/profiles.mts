// Buildings' profiles: what each is for, when it was built and last renewed, how it stands, how it rates, a verdict,
// facts each citing its sources, where to read more, and photos others may reuse with credit. Each building is
// researched and judged by hand into one record, src/places/profiles/<slug>.json (Judged); the build reads them all
// into one file for the map (Profiles, by scripts/map/profiles.mts), keyed by the gazetteer's name for each building:
// each record less its notes, with the overall rating and rank worked out from the six scores, never typed. Pure, so
// the build, the tests, the pages and the Worker share it

import * as v from "valibot"
import { describeIssues } from "../shared/json.mts"

/** What a building is for, never how old it is, each as a page heads it */
export const CATEGORIES = {
  "academic":       "Academic",
  "residence":      "Residence hall",
  "dining":         "Dining",
  "student-life":   "Student life",
  "arts":           "Arts",
  "athletics":      "Athletics",
  "administration": "Administration",
  "library":        "Library",
  "research-farm":  "Research and farms",
  "support":        "Campus support"
}
export type Category = keyof typeof CATEGORIES

/** How a building stands, in words; anything but in use is said on its page */
export const STATUSES = {
  "in-use":             "In use",
  "closed":             "Closed",
  "proposed-closure":   "Proposed closure",
  "under-construction": "Under construction",
  "demolished":         "Demolished",
  "not-unh":            "Not UNH's"
}
export type Status = keyof typeof STATUSES

/**
 * The six dimensions a building is scored on, each 1 to 10 against the brief's anchors, in the order a page lists
 * them, by its weight in the overall, in twentieths: a fifth each for how it looks and what it is, less for its state
 * and use, least for its name
 */
export const WEIGHTS = { exterior: 4, interior: 4, character: 4, condition: 3, function: 3, reputation: 2 }
export type Dimension = keyof typeof WEIGHTS
export const DIMENSIONS = Object.keys(WEIGHTS) as Dimension[]

/**
 * The widths photos are served at, in pixels, and no others, so the Worker makes each photo twice at most: a strip's
 * tile at three device pixels a point, and the viewer's, a phone's screen across
 */
export const PHOTO_WIDTHS = [500, 1280] as const
export type PhotoWidth = typeof PHOTO_WIDTHS[number]

const Text = v.pipe(v.string(), v.trim(), v.nonEmpty())
const Link = v.pipe(v.string(), v.url(), v.regex(/^https?:\/\//, "Not a web address"))
const Year = v.pipe(v.number(), v.integer(), v.minValue(1600), v.maxValue(2100))
const Score = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10))
const Ids = v.pipe(v.array(v.string()), v.nonEmpty("Nothing cited"))

/** The six scores, as the judge gives them */
export const Scores = v.object(Object.fromEntries(DIMENSIONS.map(dimension => [dimension, Score])) as Record<Dimension, typeof Score>)
export type Scores = v.InferOutput<typeof Scores>

/** Something cited, by the id facts cite it by */
const Source = v.object({ title: Text, publisher: v.optional(Text), url: Link })
export type Source = v.InferOutput<typeof Source>

const Photo = v.object({
  /**
   * The photo itself, from Wikimedia Commons or Flickr, under a license that allows reuse with credit, about as wide
   * as the viewer shows it where there's a choice; never shown from there, only through the Worker, which fetches it
   * as it is here
   */
  url:        v.pipe(Link, v.regex(/^https:\/\/((upload|thumb)\.wikimedia\.org\/wikipedia\/commons|live\.staticflickr\.com)\//, "Not a photo on Wikimedia Commons or Flickr")),
  /** Its page there, which the credit links to */
  page:       Link,
  credit:     Text,
  license:    Text,
  licenseUrl: v.optional(Link),
  view:       v.picklist(["exterior", "interior", "aerial", "detail", "historic"]),
  year:       v.optional(Year),
  caption:    Text
})
export type Photo = v.InferOutput<typeof Photo>

/** What a record and its profile share */
const Shown = {
  name:       Text,
  aliases:    v.optional(v.array(Text), []),
  category:   v.picklist(Object.keys(CATEGORIES) as Category[]),
  use:        v.optional(Text),
  built:      v.optional(Year),
  architect:  v.optional(Text),
  style:      v.optional(Text),
  status:     v.picklist(Object.keys(STATUSES) as Status[]),
  statusNote: v.optional(Text),
  facts:      v.optional(v.array(v.object({ text: Text, src: Ids })), []),
  photos:     v.optional(v.array(Photo), []),
  more:       v.optional(v.array(v.object({ label: Text, url: Link })), []),
  confidence: v.picklist(["high", "med", "low"]),
  verdict:    v.optional(Text)
}

/**
 * One building as researched and judged, src/places/profiles/<slug>.json. Scores only where it's ranked among the
 * campus's buildings: a field, a building that's gone, not UNH's or not up yet has none. The notes are for whoever
 * amends it: what the sources disagree on, and why it's scored as it is
 */
export const Judged = v.object({
  ...Shown,
  /** The gazetteer's name for it, as the map loads it, or null for one the map has no place for */
  place:       v.nullable(Text),
  /** What the sources say of when it was built, where that's more than a year */
  builtText:   v.optional(Text),
  renovations: v.optional(v.array(v.object({
    /** When, where the sources say; an undated one never counts as when it was renovated */
    year:  v.optional(Year),
    what:  Text,
    cost:  v.optional(v.number()),
    /** Whether it renewed the building, so counts as when it was last renovated */
    major: v.boolean(),
    src:   v.optional(v.array(v.string()), [])
  })), []),
  sources:     v.record(v.string(), v.object({ ...Source.entries, accessed: v.optional(v.string()) })),
  ratings:     v.optional(Scores),
  notes:       v.optional(Text),
  judgeNotes:  v.optional(Text)
})
export type Judged = v.InferOutput<typeof Judged>

/** A building's profile as the map loads it: its record less the notes, with the sources its facts cite */
export const Profile = v.object({
  ...Shown,
  /** The year of its last major renovation since it was built */
  renovated: v.optional(Year),
  sources:   v.record(v.string(), Source),
  /** Its scores, their weighted mean to a tenth, and its rank among the buildings rated, equals sharing one */
  rating:    v.optional(v.object({ ...Scores.entries, overall: v.number(), rank: v.number() }))
})
export type Profile = v.InferOutput<typeof Profile>
export type Rating = NonNullable<Profile["rating"]>

/** Every profile, by the gazetteer's name for its building, and how many buildings are rated, on the map or not */
export const Profiles = v.object({ ranked: v.number(), profiles: v.record(v.string(), Profile) })
export type Profiles = v.InferOutput<typeof Profiles>

/** What profiles load as when their file can't: none, so places' pages show none */
export const NO_PROFILES: Profiles = { ranked: 0, profiles: {} }

/** A place's profile, by the gazetteer's name for it, if it has one */
export const profileNamed = ({ profiles }: Profiles, name: string) =>
  Object.hasOwn(profiles, name) ? profiles[name] : undefined

/** The overall rating: the scores' weighted mean, to a tenth, halves up */
export const overallOf = (scores: Scores) =>
  Math.round(DIMENSIONS.reduce((sum, dimension) => sum + scores[dimension] * WEIGHTS[dimension], 0) / 2) / 10

/** The year of a building's last major renovation since it was built, or none */
export const lastRenovated = ({ built, renovations }: Pick<Judged, "built" | "renovations">) =>
  renovations.flatMap(({ major, year }) => major && year !== undefined && (built === undefined || year > built) ? [year] : []).sort((a, b) => b - a)[0]

/**
 * A photo as the Worker serves it (worker/photos.mts), by its address as published, at one of the widths; under the
 * API, so the service worker leaves it to the browser's own cache
 */
export const photoSrc = (url: string, width: PhotoWidth) =>
  `/api/photo?${new URLSearchParams({ src: url, w: String(width) })}`

const ORDINALS = new Intl.PluralRules("en-US", { type: "ordinal" })
const SUFFIXES: Partial<Record<Intl.LDMLPluralRule, string>> = { one: "st", two: "nd", few: "rd" }

/** A rank in words, "1st", "22nd", "83rd" */
export const ordinal = (n: number) =>
  `${n}${SUFFIXES[ORDINALS.select(n)] ?? "th"}`

/** When a building was built and last renewed, as a page's facts list them: "Built 1893", "renovated 2007" */
export const eraParts = ({ built, renovated }: Pick<Profile, "built" | "renovated">) =>
  [...built === undefined ? [] : [`Built ${built}`], ...renovated === undefined ? [] : [`renovated ${renovated}`]]

/** How a building stands, unless it's in use as ever: "Closed: Minis closed at the end of spring 2026" */
export const statusText = ({ status, statusNote }: Pick<Profile, "status" | "statusNote">) =>
  status === "in-use" ? undefined : `${STATUSES[status]}${statusNote ? `: ${statusNote}` : ""}`

/** Where a rating stands: "4th of 103", and "low confidence" where the evidence was thin */
export const rankText = ({ rating, confidence }: Pick<Profile, "rating" | "confidence">, ranked: number) =>
  rating && `${ordinal(rating.rank)} of ${ranked}${confidence === "low" ? " · low confidence" : ""}`

/** A rating in a line, "7.9 of 10 · 4th of 103", or none */
export const ratingText = (profile: Pick<Profile, "rating" | "confidence">, ranked: number) =>
  profile.rating && `${profile.rating.overall} of 10 · ${rankText(profile, ranked)}`

/**
 * A judged record's profile, ranked as given, with the sources its facts cite, and each citation of a source it
 * hasn't got, as a problem
 */
const profileOf = ({ place, builtText, renovations, sources, ratings, notes, judgeNotes, ...shown }: Judged, rank: number | undefined) => {
  const has = (id: string) => Object.hasOwn(sources, id)
  const problems = [...shown.facts.map(({ src }, i) => [`fact ${i + 1}`, src] as const), ...renovations.map(({ src }, i) => [`renovation ${i + 1}`, src] as const)]
    .flatMap(([what, src]) => src.filter(id => !has(id)).map(id => `${what} cites ${id}, which isn't among its sources`))
  const renovated = lastRenovated({ built: shown.built, renovations })
  const profile: Profile = {
    ...shown,
    ...renovated !== undefined && { renovated },
    sources: Object.fromEntries([...new Set(shown.facts.flatMap(({ src }) => src))].filter(has).map(id => {
      const { accessed, ...source } = sources[id]
      return [id, source]
    })),
    ...ratings && rank !== undefined && { rating: { ...ratings, overall: overallOf(ratings), rank } }
  }
  return { profile, problems }
}

/**
 * The profiles of judged records, by file name, keyed by the gazetteer's name for each building, ranked among them
 * all by overall, equals sharing a rank, and every problem found: a record that isn't one, a citation of no source
 * it has, a building the map doesn't name, or one named twice. A record for a building the map has no place for,
 * its place null, is ranked among the rest but left out
 */
export const profilesOf = (files: readonly (readonly [file: string, json: unknown])[], names: ReadonlySet<string>) => {
  const problems: string[] = []
  const records: [file: string, record: Judged][] = []
  for (const [file, json] of files) {
    const result = v.safeParse(Judged, json)
    if (result.success)
      records.push([file, result.output])
    else
      problems.push(`${file}: ${describeIssues(result.issues.map(({ message, path }) => ({ message, path: path?.map(({ key }) => String(key)) })))}`)
  }
  const overalls = records.flatMap(([, { ratings }]) => ratings ? [overallOf(ratings)] : []).sort((a, b) => b - a)
  const profiles: Record<string, Profile> = {}
  const by = new Map<string, string>()
  for (const [file, record] of records) {
    const { profile, problems: found } = profileOf(record, record.ratings && overalls.indexOf(overallOf(record.ratings)) + 1)
    problems.push(...found.map(problem => `${file}: ${problem}`))
    if (record.place === null)
      continue
    if (!names.has(record.place))
      problems.push(`${file}: the map names no place "${record.place}"`)
    else if (by.has(record.place))
      problems.push(`${file}: "${record.place}" is ${by.get(record.place)}'s already`)
    else {
      by.set(record.place, file)
      profiles[record.place] = profile
    }
  }
  return { data: { ranked: overalls.length, profiles } satisfies Profiles, problems }
}

/** The other names a profiled building goes by in search, its own where the map's differs and its aliases, as [name, place] pairs */
export const searchNamesOf = ({ profiles }: Profiles) =>
  Object.entries(profiles).flatMap(([place, { name, aliases }]) =>
    [...name === place ? [] : [name], ...aliases].map(alias => [alias, place] as const))
