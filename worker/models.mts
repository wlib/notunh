// What the nightly build stores whole, each by name and a day: the models it fits, the latest being the last stored,
// whatever day it runs through, kept a month of writes back to go back to, and the timetable, archived once per version it sees, as of the day it first did, so a day's visits
// can always be replayed against the timetable then in force

import type { DrizzleD1Database } from "drizzle-orm/d1"
import { and, asc, desc, eq, lt, lte, max, sql } from "drizzle-orm"
import type { Day } from "../src/shared/time.mts"
import { models } from "./schema.mts"

/** What there is: the map's buses, laundry's rooms, and the GTFS feed by version */
export const MODELS = ["buses", "laundry", "gtfs"]

// Kept of each name, the last stored, one a night, or a feed version
const KEEP = 30

/**
 * The latest of a name, the last stored, or the latest through a day, as the only row if there is one, with its
 * revision
 */
export const latestModel = (db: DrizzleD1Database, name: string, through?: Day) =>
  db.select({ state: models.state, revision: models.revision }).from(models)
    .where(and(eq(models.name, name), through === undefined ? undefined : lte(models.through, through)))
    .orderBy(through === undefined ? desc(models.written) : desc(models.through)).limit(1)

/** Every day a name is stored through, in order */
export const throughsOf = (db: DrizzleD1Database, name: string) =>
  db.select({ through: models.through }).from(models).where(eq(models.name, name)).orderBy(asc(models.through))

/**
 * Stores a state through a day as the latest, replacing one through the same day, if the latest stored is still the
 * one the writer read, by its revision, or none: whether it was, which two builds learning at once settle by, as the
 * one that reads the other's work is the one that goes on from it. Every write is a new revision, so two writers
 * can't both succeed, and the latest is never through a later day than it's checked against. Those stored before
 * the last 30 go
 */
export const saveModel = async (db: DrizzleD1Database, name: string, through: Day, state: unknown, expect: string | null) => {
  const { meta } = await db.run(sql`
    insert into ${models} (name, through, state, revision, written)
    select ${name}, ${through}, ${JSON.stringify(state)}, ${crypto.randomUUID()}, coalesce(max(written), 0) + 1
    from ${models} where name = ${name}
    having coalesce((select revision from ${models} where name = ${name} order by written desc limit 1), '') = ${expect ?? ""}
    on conflict (name, through) do update set state = excluded.state, revision = excluded.revision, written = excluded.written
  `)
  if (!meta.changes)
    return false
  const kept = db.select({ written: models.written }).from(models).where(eq(models.name, name)).orderBy(desc(models.written)).limit(1).offset(KEEP - 1)
  await db.delete(models).where(and(eq(models.name, name), lt(models.written, kept)))
  return true
}

/** The day the latest of each stored name runs through, as SQLite gives a bare column of the row max() picks */
export const throughs = (db: DrizzleD1Database) =>
  db.select({ name: models.name, through: models.through, written: max(models.written) }).from(models).groupBy(models.name)
