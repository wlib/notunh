// Every table in the Worker's D1 database, which `npm run db:generate` writes worker/migrations from. Instants are
// epoch milliseconds

import { customType, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Kind, Status, Machine } from "../src/laundry/infer.mts"
import type { Time } from "../src/social/event.mts"
import type { Subscription } from "./push.mts"

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
 * What learning derives from a service day's observations (scripts/map/model.mts), by name (visits, statistics,
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
 * Every timetable acquired, by id, the SHA-256 of the JSON it was converted to (src/map/gtfs.json), with the original
 * GTFS zip and its SHA-256, source. A row per acquisition, made when learning sees another than the last acquired
 * (scripts/map/replay.mts), at the Worker's time then. version, start, and end are what the feed itself says, "" where
 * it says nothing. Kept forever: a few a year, about 0.5 MB each
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
 * Each model learned (scripts/learn.mts), by name and the last day in it, read and written whole. Each write gets its
 * own revision, and a writer must have read the latest revision to store over it. written numbers writes in order,
 * and that order, not through, decides the latest, since a model of a new version can run through an earlier day
 * than the one it replaces
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

/** Each laundry run, with the rooms it couldn't fetch, so learning knows which stretches each room was watched */
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

//#region Social (social.mts, docs/social.md)

/**
 * Each device that has asked anything social, by the id it made itself (src/reminders/browser/store.mts): the SHA-256
 * of its secret, set by its first ask and checked by every one after, the person it belongs to, its own id until
 * it's linked to another device's (links), and the push subscription its last mark came with, for asking it "Going?"
 * when a time it marked is set, dropped once the push service says it's gone
 */
export const devices = sqliteTable("devices", {
  id:      text().primaryKey(),
  secret:  text().notNull(),
  person:  text().notNull(),
  push:    text({ mode: "json" }).$type<Subscription>(),
  created: integer().notNull()
}, table => [index("devices_person").on(table.person)])

/**
 * A handoff between devices: the code the new device shows, and which device it is. The old device approves it within
 * its two minutes, which moves the new device to the old one's person. Dropped once expired
 */
export const links = sqliteTable("links", {
  code:    text().primaryKey(),
  device:  text().notNull(),
  expires: integer().notNull(),
  linked:  integer({ mode: "boolean" }).notNull().default(false)
})

/**
 * Each UNH address someone has typed, lower-cased: who holds it verified, and since when, and the attempt under way,
 * if any: who's trying, the SHA-256 of the six-digit code sent them, when it expires, and the tries so far. Kept
 * until the person asks to be forgotten
 */
export const emails = sqliteTable("emails", {
  address:  text().primaryKey(),
  person:   text(),
  verified: integer(),
  pending:  text(),
  code:     text(),
  expires:  integer(),
  tries:    integer().notNull().default(0)
}, table => [index("emails_person").on(table.person)])

/**
 * Each pin as its host set it (src/social/event.mts): an event with a description, by the person who made it, under
 * an id their device made, so making it again is the same pin. times are the candidates while its time is to pick,
 * earliest first, and its window spans them, until the host sets one, chosen, which becomes its window. spots is how
 * many may go, if limited. Dropped two hours after its end (LINGER)
 */
export const pins = sqliteTable("pins", {
  id:          text().primaryKey(),
  person:      text().notNull(),
  title:       text().notNull(),
  description: text().notNull(),
  place:       text(),
  where:       text().notNull(),
  start:       integer().notNull(),
  end:         integer().notNull(),
  times:       text({ mode: "json" }).$type<Time[]>().notNull(),
  chosen:      integer(),
  spots:       integer(),
  visibility:  text().$type<"link" | "public">().notNull(),
  created:     integer().notNull()
}, table => [index("pins_end").on(table.end), index("pins_person").on(table.person)])

/**
 * Your things kept for you as a person, beside each device's copy (src/shared/sync.mts): one row a key, its value as
 * JSON, and when and by which device it was written, the newer of two writes winning. Moved with a device to the
 * person it's linked to, or recovered as by a UNH address, keeping each key's newer row
 */
export const state = sqliteTable("state", {
  person: text().notNull(),
  key:    text().notNull(),
  value:  text({ mode: "json" }).notNull(),
  at:     integer().notNull(),
  by:     text().notNull()
}, table => [primaryKey({ columns: [table.person, table.key] })])

/** Who's going to a pin with a time, by device: a count to everyone, never a list */
export const going = sqliteTable("going", {
  pin:    text().notNull(),
  device: text().notNull()
}, table => [primaryKey({ columns: [table.pin, table.device] })])

/** Each time of a pin a device marked as working for it, by the time's index, once each (src/social/marks.mts) */
export const marks = sqliteTable("marks", {
  pin:    text().notNull(),
  device: text().notNull(),
  time:   integer().notNull()
}, table => [primaryKey({ columns: [table.pin, table.device, table.time] })])

/** Which devices reported a pin; two hide it */
export const reports = sqliteTable("reports", {
  pin:    text().notNull(),
  device: text().notNull()
}, table => [primaryKey({ columns: [table.pin, table.device] })])

//#endregion
