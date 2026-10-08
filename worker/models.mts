// The models the nightly build fits, each kept by name for the last day in it, a month of nights back

import type { DrizzleD1Database } from "drizzle-orm/d1"
import { and, desc, eq, lt, max } from "drizzle-orm"
import type { Day } from "../src/shared/time.mts"
import { models } from "./schema.mts"

/** The models there are: the map's buses, and laundry's rooms */
export const MODELS = ["buses", "laundry"]

// Models kept of each, one per night, to go back to
const KEEP = 30

/** The latest model of a name, as the only row if one has been fitted */
export const latestModel = (db: DrizzleD1Database, name: string) =>
  db.select({ state: models.state }).from(models).where(eq(models.name, name)).orderBy(desc(models.through)).limit(1)

/** Statements that store a model through a day, replacing one through the same day and dropping old ones */
export const saveModel = (db: DrizzleD1Database, name: string, through: Day, state: unknown) => {
  const kept = db.select({ through: models.through }).from(models).where(eq(models.name, name)).orderBy(desc(models.through)).limit(1).offset(KEEP - 1)
  return [
    db.insert(models).values({ name, through, state }).onConflictDoUpdate({ target: [models.name, models.through], set: { state } }),
    db.delete(models).where(and(eq(models.name, name), lt(models.through, kept)))
  ] as const
}

/** The last day each stored model runs through */
export const throughs = (db: DrizzleD1Database) =>
  db.select({ name: models.name, through: max(models.through) }).from(models).groupBy(models.name)
