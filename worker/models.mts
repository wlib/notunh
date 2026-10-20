// What the nightly build stores whole, each by name and day:
// - the models it publishes, and its checkpoints of learning them (scripts/learn.mts). The latest of each is the
//   last stored, whatever day it runs through, and the last KEEP writes are kept to roll back to
// - the timetable (gtfs), archived once per feed version as of the day it was first seen, so a day's visits can
//   always be replayed against the timetable then in force

import type { DrizzleD1Database } from "drizzle-orm/d1"
import { and, asc, desc, eq, lt, lte, max, sql } from "drizzle-orm"
import type { Day } from "../src/shared/time.mts"
import { checkpointOf } from "../src/shared/learn.mts"
import { models } from "./schema.mts"

/** What there is: the map's buses, laundry's rooms, and the GTFS feed by version */
export const MODELS = ["buses", "laundry", "gtfs"]

/** What's stored: those, plus checkpoints of the learned ones, which the build continues from */
export const STORED = [...MODELS, ...["buses", "laundry"].map(checkpointOf)]

// Writes kept of each name: a month of nightly models, or the last 30 feed versions
const KEEP = 30

/** A name's latest state and its revision: the last stored, or given a day, the one through the latest day up to it */
export const latestModel = (db: DrizzleD1Database, name: string, through?: Day) =>
  db.select({ state: models.state, revision: models.revision }).from(models)
    .where(and(eq(models.name, name), through === undefined ? undefined : lte(models.through, through)))
    .orderBy(through === undefined ? desc(models.written) : desc(models.through)).limit(1)

/** Every day a name is stored through, in order */
export const throughsOf = (db: DrizzleD1Database, name: string) =>
  db.select({ through: models.through }).from(models).where(eq(models.name, name)).orderBy(asc(models.through))

/**
 * Stores a state through a day as the latest, replacing any through the same day, but only if the latest stored is
 * still the revision the writer read (or there's none, for null). Resolves to whether it stored. This settles two
 * builds learning at once: the loser rereads the winner's work and goes on from it. Every write gets a new revision,
 * so two writers can't both succeed. Writes older than the last KEEP are deleted
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
