// What learning stores whole (scripts/learn.mts):
// - the models, each by name and the day it runs through. The latest of each is the last stored, whatever day it runs
//   through, and the last KEEP writes are kept to roll back to
// - every timetable acquired, kept for as long as the observations it interprets, which is forever

import type { DrizzleD1Database } from "drizzle-orm/d1"
import { and, asc, desc, eq, lt, max, sql } from "drizzle-orm"
import type { Day } from "../src/shared/time.mts"
import { feeds, models } from "./schema.mts"

/** What's learned: the map's buses and laundry's rooms */
export const MODELS = ["buses", "laundry"]

// Writes kept of each name: a month of nightly models
const KEEP = 30

/** A name's latest state and its revision */
export const latestModel = (db: DrizzleD1Database, name: string) =>
  db.select({ state: models.state, revision: models.revision }).from(models)
    .where(eq(models.name, name)).orderBy(desc(models.written)).limit(1)

/**
 * Stores a state through a day as the latest, replacing any through the same day, but only if the latest stored is
 * still the revision the writer read (or there's none, for null). Resolves to whether it stored. This settles two runs
 * learning at once: the loser's write is refused, and what it writes among the inputs is the winner's. Every write gets
 * a new revision, so two writers can't both succeed. Writes older than the last KEEP are deleted
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

/** Every acquisition of a timetable, the earliest first, those of the same instant as they were made, without contents */
export const feedList = (db: DrizzleD1Database) =>
  db.select({ id: feeds.id, acquired: feeds.acquired, version: feeds.version, start: feeds.start, end: feeds.end }).from(feeds).orderBy(asc(feeds.acquired), sql`rowid`)

/** A timetable's JSON, by its id, or undefined if it was never acquired */
export const feedJson = async (db: DrizzleD1Database, id: string) =>
  (await db.select({ feed: feeds.feed }).from(feeds).where(eq(feeds.id, id)).limit(1).get())?.feed

/** Acquires a timetable as of an instant, unless it's the one last acquired. Resolves to whether it was acquired */
export const acquireFeed = async (db: DrizzleD1Database, feed: Omit<typeof feeds.$inferInsert, "acquired">, at: number) => {
  const { id, source, version, start, end, feed: json, original } = feed
  const { meta } = await db.run(sql`
    insert into ${feeds} (id, acquired, source, version, start, "end", feed, original)
    select ${id}, ${at}, ${source}, ${version}, ${start}, ${end}, ${json}, ${original}
    where coalesce((select id from ${feeds} order by acquired desc, rowid desc limit 1), '') != ${id}
  `)
  return meta.changes > 0
}
