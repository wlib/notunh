// Every table the build reads and writes, by name, each with the column its days are on when it has one: epoch
// milliseconds, or schedule seconds for visits, as src/map/events.mts keeps them. Reads page by rowid, so rows come
// back in the order they were stored, and the build sorts where it must

import { drizzle } from "drizzle-orm/d1"
import { and, asc, desc, eq, getTableColumns, getTableName, gt, gte, lt, sql, type SQL } from "drizzle-orm"
import type { BatchItem } from "drizzle-orm/batch"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import { HOUR, addDays, dayStart, type Day } from "../src/shared/time.mts"
import { serviceDayStart } from "../src/map/feed.mts"
import { latest, polls, samples, transitions, visits } from "./schema.mts"
import { MODELS, throughs } from "./models.mts"
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
  /** How many days the nightly run keeps, by the Env variable naming it */
  keep?:     "RETAIN_DAYS" | "RETAIN_VISIT_DAYS",
  canWrite?: true
}

const serviceDay = (day: Day): [number, number] =>
  [serviceDayStart(day), serviceDayStart(addDays(day, 1))]

const calendarDay = (day: Day): [number, number] =>
  [dayStart(day), dayStart(addDays(day, 1))]

/** A sampled source's minutes, bodies in hex as SQLite writes them for free, about 1.5 KB of it each */
const sampled = (source: string): Entry => ({
  table: samples, at: samples.at, where: eq(samples.source, source), span: serviceDay, keep: "RETAIN_DAYS", page: 200,
  columns: { at: samples.at, body: sql<string>`hex(${samples.body})` }
})

export const ROWS: Record<string, Entry> = {
  buses:       sampled("buses"),
  predictions: sampled("predictions"),
  visits:      { table: visits, at: visits.arrive, span: day => serviceDay(day).map(ms => ms / 1000) as [number, number], keep: "RETAIN_VISIT_DAYS", canWrite: true },
  transitions: { table: transitions, at: transitions.at, span: calendarDay, keep: "RETAIN_DAYS" },
  polls:       { table: polls, at: polls.at, span: calendarDay, pad: HOUR, keep: "RETAIN_DAYS" },
  machines:    { table: latest }
}

// A page of rows
const PAGE = 1000
// Of the 50 queries D1 allows an invocation on the free plan, what a write may insert with, after its delete
const INSERTS = 48

/** How many of a table's rows fit one insert, within D1's 100 bound parameters a statement */
const rowsPerInsert = (table: SQLiteTable) =>
  Math.floor(100 / Object.keys(getTableColumns(table)).length)

/** Rows split into as few inserts as the bound parameters allow */
export const chunks = <T,>(table: SQLiteTable, rows: readonly T[]) => {
  const size = rowsPerInsert(table)
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
  return chunks(table, rows).map(chunk =>
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

/** The most rows one write takes */
export const maxRows = ({ table }: Entry) =>
  INSERTS * rowsPerInsert(table)

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

/** Stores rows, first clearing a day's when asked to, as when it's extracted again; rows already there stay */
export const write = (env: Env, entry: Entry, rows: readonly Record<string, unknown>[], clear?: Day) => {
  const db = drizzle(env.DB)
  return batch(db, [
    ...clear !== undefined && entry.span ? [db.delete(entry.table).where(within(entry, entry.span(clear)))] : [],
    ...chunks(entry.table, rows).map(chunk => db.insert(entry.table).values(chunk).onConflictDoNothing())
  ])
}

/** Drops every row older than its table keeps, counting back from the day of today */
export const prune = (env: Env, today: Day) => {
  const db = drizzle(env.DB)
  return batch(db, Object.values(ROWS).flatMap(({ table, at, where, span, keep }) =>
    at && span && keep ? [db.delete(table).where(and(where, lt(at, span(addDays(today, -env[keep]))[0])))] : []
  ))
}

/** When each table with days starts and ends, in its own unit, from two index lookups each, and the day each model runs through */
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
