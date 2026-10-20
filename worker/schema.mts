// Every table in the Worker's D1 database, which `npm run db:generate` writes worker/migrations from. Instants are
// epoch milliseconds

import { customType, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Kind, Status, Machine } from "../src/laundry/infer.mts"

/**
 * The version of what the Worker's /api/ routes take and give the build, which /api/health reports. Bumped with any
 * change to them, so a build learns only against a Worker of its own version, and only reads from another, as from
 * the Worker it runs before deploying (scripts/learn.mts)
 */
export const API = 2

/** Raw bytes, which D1 takes as they are */
const bytes = customType<{ data: Uint8Array<ArrayBuffer>, driverData: Uint8Array<ArrayBuffer> }>({
  dataType: () => "blob"
})

/**
 * What each source saw in a minute it polled, and its polls, as gzipped JSON tuples packed by
 * src/transit/observations/raw.mts, 4 to 6 times smaller than rows of them would be. Kept RETAIN_ARCHIVED_DAYS once
 * the observations archive has the day (src/transit/observations/archive.mts), and until then, however long that takes
 */
export const samples = sqliteTable("samples", {
  source: text().notNull(),
  /** The minute's start */
  at:     integer().notNull(),
  body:   bytes().notNull()
}, table => [primaryKey({ columns: [table.source, table.at] })])

/**
 * What the build derives from a service day's observations (scripts/map/model.mts), by name (visits, statistics,
 * evaluation) and the day's start, each published whole. Its content is written first, as immutable chunks under a
 * generation of its own, and this row, its manifest, commits it: the generation, and how many parts it has. Readers
 * go by the manifest alone, so they see a generation whole or not at all. identity is exactly what it was derived
 * from, so it's reused for that and nothing else. Kept RETAIN_VISIT_DAYS for visits, else RETAIN_STATISTICS_DAYS
 */
export const derived = sqliteTable("derived", {
  name:       text().notNull(),
  at:         integer().notNull(),
  identity:   text().notNull(),
  generation: text().notNull(),
  parts:      integer().notNull()
}, table => [primaryKey({ columns: [table.name, table.at] })])

/** A generation's gzipped JSON, in parts within the 2 MB D1 keeps a row to */
export const chunks = sqliteTable("chunks", {
  generation: text().notNull(),
  part:       integer().notNull(),
  body:       bytes().notNull()
}, table => [primaryKey({ columns: [table.generation, table.part] })])

/**
 * Every timetable a build has acquired, by id, the SHA-256 of the JSON it was converted to (src/map/gtfs.json), with
 * the original GTFS zip and its SHA-256, source. A row per acquisition, made when a build sees another than the last
 * acquired, at the Worker's time then. version, start, and end are what the feed itself says, "" where it says
 * nothing. Kept forever: a few a year, about 0.5 MB each
 */
export const feeds = sqliteTable("feeds", {
  id:       text().notNull(),
  acquired: integer().notNull(),
  source:   text().notNull(),
  version:  text().notNull(),
  start:    text().notNull(),
  end:      text().notNull(),
  feed:     text().notNull(),
  original: bytes().notNull()
}, table => [index("feeds_id").on(table.id)])

/**
 * Each model the nightly build fitted, by name and the last day in it, read and written whole. Each write gets its
 * own revision, and a writer must have read the latest revision to store over it. written numbers writes in order,
 * and that order, not through, decides the latest, since a refit's checkpoint can run through an earlier day than
 * what it replaces
 */
export const models = sqliteTable("models", {
  name:     text().notNull(),
  through:  text().notNull(),
  state:    text({ mode: "json" }).$type<unknown>().notNull(),
  revision: text().notNull(),
  written:  integer().notNull()
}, table => [primaryKey({ columns: [table.name, table.through] })])

/**
 * Each laundry machine's status changes, and its first sighting, as worker/laundry.mts records them every 5 minutes
 * (15 overnight), so writes track people doing laundry rather than polls
 */
export const transitions = sqliteTable("transitions", {
  machine:   text().notNull(),
  room:      text().notNull(),
  at:        integer().notNull(),
  status:    text().$type<Status>().notNull(),
  /** The vendor's own status id */
  raw:       text().notNull(),
  remaining: integer().notNull(),
  cycle:     text()
}, table => [index("transitions_at").on(table.at)])

/** Each laundry machine as of its last change, to diff the next poll against and to answer for its room when the vendor can't */
export const latest = sqliteTable("latest", {
  machine:   text().primaryKey(),
  room:      text().notNull(),
  kind:      text().$type<Kind>().notNull(),
  number:    text().notNull(),
  model:     text().notNull(),
  /** Which of a stacked pair it is */
  stack:     text().$type<"upper" | "lower">(),
  status:    text().$type<Status>().notNull(),
  raw:       text().notNull(),
  /** When it changed */
  at:        integer().notNull(),
  /** When the machine itself last reported, as of that change */
  reported:  integer().notNull(),
  remaining: integer().notNull(),
  cycle:     text()
})

/** Each laundry run, with the rooms it couldn't fetch, so the build knows which stretches of time each room was watched */
export const polls = sqliteTable("polls", {
  at:     integer().primaryKey(),
  failed: text({ mode: "json" }).$type<string[]>().notNull()
})

/** One current snapshot per room, refreshed even when no machine changes status */
export const roomSnapshots = sqliteTable("room_snapshots", {
  room:     text().primaryKey(),
  at:       integer().notNull(),
  machines: text({ mode: "json" }).$type<Machine[]>().notNull()
})
