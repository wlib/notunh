// Every table in the Worker's D1 database, which `npm run db:generate` writes worker/migrations from. Instants are
// epoch milliseconds, except in visits, which keeps the timetable's schedule seconds

import { customType, index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Kind, Status, Machine } from "../src/laundry/infer.mts"

/** Raw bytes, which D1 takes as they are */
const bytes = customType<{ data: Uint8Array<ArrayBuffer>, driverData: Uint8Array<ArrayBuffer> }>({
  dataType: () => "blob"
})

/**
 * What each source saw in a minute, gzipped JSON tuples as src/map/raw.mts packs them, which is 4 to 6 times
 * smaller than rows of them would be. Only kept RETAIN_DAYS, long enough to extract them again
 */
export const samples = sqliteTable("samples", {
  source: text().notNull(),
  /** The minute's start */
  at:     integer().notNull(),
  body:   bytes().notNull()
}, table => [primaryKey({ columns: [table.source, table.at] })])

/**
 * Each bus's visits to stops, exactly as src/map/events.mts extracts them from samples, kept RETAIN_VISIT_DAYS so
 * the model can be refit from them long after the samples are gone
 */
export const visits = sqliteTable("visits", {
  vehicle:   text().notNull(),
  route:     text().notNull(),
  stop:      text().notNull(),
  arrive:    real().notNull(),
  depart:    real().notNull(),
  trip:      text(),
  position:  integer(),
  isEnd:     integer("is_end", { mode: "boolean" }),
  scheduled: real(),
  from:      text(),
  meters:    real(),
  left:      real(),
  gotIn:     real("got_in"),
  umo:       text({ mode: "json" }).$type<(number | null)[]>()
}, table => [
  primaryKey({ columns: [table.vehicle, table.arrive] }),
  index("visits_arrive").on(table.arrive)
])

/** Each model the nightly build fitted, by name and the last day in it, read and written whole */
export const models = sqliteTable("models", {
  name:    text().notNull(),
  through: text().notNull(),
  state:   text({ mode: "json" }).$type<unknown>().notNull()
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
  room: text().primaryKey(),
  at: integer().notNull(),
  machines: text({ mode: "json" }).$type<Machine[]>().notNull()
})
