// What the nightly build stores whole, each by name and a day: the models it fits, kept a month of nights back to
// go back to, and the timetable, archived once per version it sees, as of the day it first did, so a day's visits
// can always be replayed against the timetable then in force

import type { DrizzleD1Database } from "drizzle-orm/d1"
import { and, asc, desc, eq, lt, lte, max, sql } from "drizzle-orm"
import type { Day } from "../src/shared/time.mts"
import { models } from "./schema.mts"

/** What there is: the map's buses, laundry's rooms, and the GTFS feed by version */
export const MODELS = ["buses", "laundry", "gtfs"]

// Kept of each name, one per night, or per feed version
const KEEP = 30

/** The latest of a name, or the latest through a day, as the only row if there is one, with its revision */
export const latestModel = (db: DrizzleD1Database, name: string, through?: Day) =>
  db.select({ state: models.state, revision: models.revision }).from(models)
    .where(and(eq(models.name, name), through === undefined ? undefined : lte(models.through, through)))
    .orderBy(desc(models.through)).limit(1)

/** Every day a name is stored through, in order */
export const throughsOf = (db: DrizzleD1Database, name: string) =>
  db.select({ through: models.through }).from(models).where(eq(models.name, name)).orderBy(asc(models.through))

/**
 * Stores a state through a day, replacing one through the same day, if the latest stored is still the one the
 * writer read, by its revision, or none: whether it was, which two builds learning at once settle by, as the one
 * that reads the other's work is the one that goes on from it. Every write is a new revision, so two writers
 * replacing the same day can't both succeed. Old ones go when a new one is kept
 */
export const saveModel = async (db: DrizzleD1Database, name: string, through: Day, state: unknown, expect: string | null) => {
  const { meta } = await db.run(sql`
    insert into ${models} (name, through, state, revision)
    select ${name}, ${through}, ${JSON.stringify(state)}, ${crypto.randomUUID()}
    where coalesce((select revision from ${models} where name = ${name} order by through desc limit 1), '') = ${expect ?? ""}
    on conflict (name, through) do update set state = excluded.state, revision = excluded.revision
  `)
  if (!meta.changes)
    return false
  const kept = db.select({ through: models.through }).from(models).where(eq(models.name, name)).orderBy(desc(models.through)).limit(1).offset(KEEP - 1)
  await db.delete(models).where(and(eq(models.name, name), lt(models.through, kept)))
  return true
}

/** The last day each stored name runs through */
export const throughs = (db: DrizzleD1Database) =>
  db.select({ name: models.name, through: max(models.through) }).from(models).groupBy(models.name)
