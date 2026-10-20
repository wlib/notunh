// How the build publishes what it derives from a service day (schema.mts derived): a generation's parts are stored
// first, immutable, and then its manifest commits it, only once every part is there, deleting the parts of the
// generation it replaces in the same transaction. A reader gets a manifest and its parts in one read, so it sees a
// day's last committed generation whole, whatever was interrupted and however many builds derived the day at once.
// Parts no manifest names, as a publication cut short leaves them, go with the nightly prune

import type { DrizzleD1Database } from "drizzle-orm/d1"
import { and, eq, lt, notInArray } from "drizzle-orm"
import { serviceDayStart } from "../src/transit/feed.mts"
import { type Day, addDays } from "../src/shared/time.mts"
import { chunks, derived } from "./schema.mts"
import type { Env } from "./collect.mts"

/** What's derived, by name, with the Env variable naming how many days of it the nightly run keeps */
export const DERIVED = {
  visits:     "RETAIN_VISIT_DAYS",
  statistics: "RETAIN_STATISTICS_DAYS",
  evaluation: "RETAIN_STATISTICS_DAYS"
} as const

export type Manifest = { identity: string, generation: string, parts: number }

const OF = "name = ? and at = ?"

/**
 * What's derived from a day by a name, as its last committed generation: the identity it was derived from, and its
 * parts in hex, read as one. Undefined while none is committed
 */
export const derivedOf = async (d1: D1Database, name: string, day: Day) => {
  const at = serviceDayStart(day)
  const [{ results: [manifest] }, { results: parts }] = await d1.batch<{ identity: string, hex: string }>([
    d1.prepare(`select identity from derived where ${OF}`).bind(name, at),
    d1.prepare(`select hex(body) as hex from chunks where generation = (select generation from derived where ${OF}) order by part`).bind(name, at)
  ])
  return manifest && { identity: manifest.identity, parts: parts.map(({ hex }) => hex) }
}

/** Stores a part of a generation, which storing again changes nothing */
export const putPart = (db: DrizzleD1Database, generation: string, part: number, body: Uint8Array<ArrayBuffer>) =>
  db.insert(chunks).values({ generation, part, body }).onConflictDoNothing()

/**
 * Commits a generation as a day's, if every part of it is stored: deletes the parts of the generation the day had,
 * and names this one in its place, as one. Resolves to whether this one is the day's now
 */
export const commit = async (d1: D1Database, name: string, day: Day, { identity, generation, parts }: Manifest) => {
  const at = serviceDayStart(day)
  const isWhole = "(select count(*) from chunks where generation = ?) = ?"
  const [, , { results: [committed] }] = await d1.batch<{ generation: string }>([
    d1.prepare(`delete from chunks where ${isWhole} and generation != ? and generation = (select generation from derived where ${OF})`)
      .bind(generation, parts, generation, name, at),
    d1.prepare(`
      insert into derived (name, at, identity, generation, parts) select ?, ?, ?, ?, ? where ${isWhole}
      on conflict (name, at) do update set identity = excluded.identity, generation = excluded.generation, parts = excluded.parts
    `).bind(name, at, identity, generation, parts, generation, parts),
    d1.prepare(`select generation from derived where ${OF}`).bind(name, at)
  ])
  return committed?.generation === generation
}

/** The nightly prune's statements: manifests older than their name keeps, then every part no manifest names */
export const expired = (db: DrizzleD1Database, env: Env, today: Day) => [
  ...Object.entries(DERIVED).map(([name, keep]) =>
    db.delete(derived).where(and(eq(derived.name, name), lt(derived.at, serviceDayStart(addDays(today, -env[keep])))))
  ),
  db.delete(chunks).where(notInArray(chunks.generation, db.select({ generation: derived.generation }).from(derived)))
]
