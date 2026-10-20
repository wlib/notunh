// Every table the build reads row by row, by name, each with the column its days are on when it has one, in epoch
// milliseconds. Reads page by rowid, so rows come back in the order they were stored, and the build sorts where it
// must. The nightly prune drops what each table no longer keeps: samples once the observations archive has their day,
// and the rest by age

import { drizzle } from "drizzle-orm/d1"
import { and, asc, desc, eq, getTableColumns, getTableName, gt, gte, is, lt, notInArray, or, sql, type SQL } from "drizzle-orm"
import type { BatchItem } from "drizzle-orm/batch"
import { type SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import { HOUR, addDays, dayStart, type Day } from "../src/shared/time.mts"
import { serviceDayStart } from "../src/transit/feed.mts"
import { ROOMS } from "../src/laundry/rooms.mts"
import * as schema from "./schema.mts"
import { latest, polls, roomSnapshots, samples, transitions } from "./schema.mts"
import { MODELS, throughs } from "./models.mts"
import { expired } from "./derived.mts"
import type { Env } from "./collect.mts"

export type Entry = {
  table:     SQLiteTable,
  /** The column its days are on */
  at?:       SQLiteColumn,
  /** Where a day starts and the next one does, in that column's unit */
  span?:     (day: Day) => [number, number],
  /** How far either side of a day rows still say something about it, like the runs just before and after */
  pad?:      number,
  where?:    SQL,
  columns?:  Record<string, SQL | SQLiteColumn>,
  /** Rows a page, when they're bigger than most */
  page?:     number,
  /** Whether the nightly run keeps only RETAIN_DAYS of it */
  isAged?:   boolean
}

const serviceDay = (day: Day): [number, number] =>
  [serviceDayStart(day), serviceDayStart(addDays(day, 1))]

const calendarDay = (day: Day): [number, number] =>
  [dayStart(day), dayStart(addDays(day, 1))]

/** A sampled source's minutes, bodies in hex as SQLite writes them for free, about 1.5 KB of it each */
const sampled = (source: string): Entry => ({
  table: samples, at: samples.at, where: eq(samples.source, source), span: serviceDay, page: 200,
  columns: { at: samples.at, body: sql<string>`hex(${samples.body})` }
})

export const ROWS: Record<string, Entry> = {
  buses:       sampled("buses"),
  predictions: sampled("predictions"),
  transitions: { table: transitions, at: transitions.at, span: calendarDay, isAged: true },
  polls:       { table: polls, at: polls.at, span: calendarDay, pad: HOUR, isAged: true },
  machines:    { table: latest }
}

// A page of rows
const PAGE = 1000

/** Rows split into as few inserts as D1's 100 bound parameters a statement allow */
const insertable = <T,>(table: SQLiteTable, rows: readonly T[]) => {
  const size = Math.floor(100 / Object.keys(getTableColumns(table)).length)
  return Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size))
}

/**
 * Rows as D1's own statements, as few as the bound parameters allow, with the columns and values Drizzle's schema
 * gives them but none of its query building, which would cost a cron's run several of its 10 ms of CPU, nor its
 * defaults, which the tables it's used on have none of. Given a key, a row there already is replaced
 */
export const inserts = <T extends SQLiteTable,>(db: D1Database, table: T, rows: readonly T["$inferInsert"][], key?: SQLiteColumn[]) => {
  const columns = Object.entries(getTableColumns(table))
  const quoted  = (column: SQLiteColumn) => `"${column.name}"`
  const names   = columns.map(([, column]) => quoted(column))
  const tuple   = `(${names.map(() => "?").join(", ")})`
  const replace = key
    ? ` on conflict (${key.map(quoted).join(", ")}) do update set ${names.map(name => `${name} = excluded.${name}`).join(", ")}`
    : ""
  return insertable(table, rows).map(chunk =>
    db
      .prepare(`insert into "${getTableName(table)}" (${names.join(", ")}) values ${chunk.map(() => tuple).join(", ")}${replace}`)
      .bind(...chunk.flatMap(row =>
        columns.map(([property, column]) => {
          const value = (row as Record<string, unknown>)[property]
          return value == null ? null : column.mapToDriverValue(value)
        })
      ))
  )
}

/** The statements as one batch, which D1 runs as a transaction */
export const batch = (db: ReturnType<typeof drizzle>, statements: BatchItem<"sqlite">[]) =>
  statements.length ? db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]) : Promise.resolve([])

const within = ({ at, where }: Entry, [from, to]: [number, number]) =>
  and(where, gte(at!, from), lt(at!, to))

/** A page of rows after a rowid, those of a day for a table with days; next is the rowid to carry on after, or null at the end */
export const read = async (env: Env, entry: Entry, day: Day | undefined, after: number) => {
  const { table, span, pad = 0, columns = getTableColumns(table), page = PAGE } = entry
  const [from, to] = day !== undefined && span ? span(day) : []
  const rows = await drizzle(env.DB)
    .select({ ...columns, rowid: sql<number>`rowid` })
    .from(table)
    .where(and(from === undefined ? entry.where : within(entry, [from - pad, to! + pad]), gt(sql`rowid`, after)))
    .orderBy(sql`rowid`)
    .limit(page)
  return { rows: rows.map(({ rowid, ...row }) => row), next: rows.length === page ? rows.at(-1)!.rowid as number : null }
}

/**
 * The service days whose samples are dropped: those the archive has, older than the window. As spans of epoch
 * milliseconds, with adjacent ones merged
 */
export const archivedSpans = (today: Day, archived: readonly Day[], window: number) => {
  const spans: [number, number][] = []
  for (const day of [...new Set(archived)].sort())
    if (day < addDays(today, -window)) {
      const [from, to] = serviceDay(day)
      const last = spans.at(-1)
      if (last?.[1] === from)
        last[1] = to
      else
        spans.push([from, to])
    }
  return spans
}

/**
 * Drops laundry's transitions and polls older than RETAIN_DAYS, counting back from the day of today, the samples of
 * days the archive has older than RETAIN_ARCHIVED_DAYS, what's derived from days past keeping (derived.mts), and
 * laundry's records of rooms no longer listed and of machines no longer in their room's snapshot, where it has one.
 * A day's samples are never dropped before the archive has it, however long that takes
 */
export const prune = (env: Env, today: Day, archived: readonly Day[] = []) => {
  const db = drizzle(env.DB)
  const rooms = ROOMS.map(({ id }) => id)
  const snapshot = (room: SQL | SQLiteColumn) => sql`select 1 from ${roomSnapshots} where ${roomSnapshots.room} = ${room}`
  const spans = archivedSpans(today, archived, env.RETAIN_ARCHIVED_DAYS)
  return batch(db, [
    ...Object.values(ROWS).flatMap(({ table, at, where, span, isAged }) =>
      at && span && isAged ? [db.delete(table).where(and(where, lt(at, span(addDays(today, -env.RETAIN_DAYS))[0])))] : []
    ),
    ...expired(db, env, today),
    ...spans.length ? [db.delete(samples).where(or(...spans.map(([from, to]) => and(gte(samples.at, from), lt(samples.at, to)))))] : [],
    db.delete(latest).where(or(
      notInArray(latest.room, rooms),
      and(
        sql`exists (${snapshot(latest.room)})`,
        sql`not exists (${snapshot(latest.room)} and exists (select 1 from json_each(${roomSnapshots.machines}) where json_extract(value, '$.id') = ${latest.machine}))`
      )
    )),
    db.delete(roomSnapshots).where(notInArray(roomSnapshots.room, rooms))
  ])
}

/** How big the database is, in bytes and in rows of each table, which reads every row, so only when asked */
export const storage = async (env: Env) => {
  const tables = Object.values(schema).filter(value => is(value, SQLiteTable)).map(getTableName)
  const counted = await env.DB.batch<{ n: number }>(tables.map(name => env.DB.prepare(`select count(*) as n from "${name}"`)))
  return {
    bytes: counted.at(-1)!.meta.size_after,
    rows:  Object.fromEntries(tables.map((name, i) => [name, counted[i].results[0].n]))
  }
}

/**
 * When each table with days starts and ends, in its own unit, from two index lookups each, and the day each model runs
 * through
 */
export const health = async (env: Env) => {
  const db = drizzle(env.DB)
  const timed = Object.entries(ROWS).filter(([, entry]) => entry.at)
  const end = ({ table, at, where }: Entry, order: typeof asc) =>
    db.select({ at: sql<number>`${at}` }).from(table).where(where).orderBy(order(at!)).limit(1)
  const [stored, ...ends] = await db.batch([throughs(db), ...timed.flatMap(([, entry]) => [end(entry, asc), end(entry, desc)])])
  const through = new Map(stored.map(({ name, through }) => [name, through]))
  return {
    ...Object.fromEntries(timed.map(([name], i) => [name, { since: ends[2 * i][0]?.at ?? null, last: ends[2 * i + 1][0]?.at ?? null }])),
    models: Object.fromEntries(MODELS.map(name => [name, through.get(name) ?? null]))
  }
}
