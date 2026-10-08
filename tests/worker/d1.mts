/// <reference types="node" />
// A D1 database for tests: Node's own SQLite behind the slice of D1's API that Drizzle uses, with every table
// worker/schema.mts declares, as drizzle-kit would migrate an empty database to

import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api"
import * as schema from "../../worker/schema.mts"

const ddl = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))

export const d1 = () => {
  const db = new DatabaseSync(":memory:")
  for (const statement of ddl)
    db.exec(statement)
  const prepare = (sql: string, params: unknown[] = []): any => {
    const values = params as SQLInputValue[]
    return {
      bind: (...bound: unknown[]) => prepare(sql, bound),
      all: async () => ({ results: db.prepare(sql).all(...values), success: true, meta: {} }),
      raw: async () => db.prepare(sql).all(...values).map(row => Object.values(row)),
      first: async () => db.prepare(sql).get(...values) ?? null,
      run: async () => ({ results: [], success: true, meta: { changes: Number(db.prepare(sql).run(...values).changes) } })
    }
  }
  return {
    prepare: (sql: string) => prepare(sql),
    batch: async (statements: any[]) => {
      db.exec("BEGIN")
      try {
        const results = []
        for (const statement of statements)
          results.push(await statement.all())
        db.exec("COMMIT")
        return results
      }
      catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
    /** For looking at what was written */
    sqlite: db
  } as unknown as D1Database & { sqlite: DatabaseSync }
}
