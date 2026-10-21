/// <reference types="node" />
// Durable Objects for tests: each object's SQLite storage in Node's own SQLite, behind the slice of the API the
// objects use (sql.exec, alarms, deleteAll), and a namespace that makes one object per name, as Cloudflare does

import { DatabaseSync, type SQLInputValue } from "node:sqlite"

/** One object's state: its SQLite storage and its one alarm */
export const durableState = () => {
  let db = new DatabaseSync(":memory:")
  let alarm: number | null = null
  const sql = {
    exec: (query: string, ...bindings: SQLInputValue[]) => {
      // A batch of statements, as a schema is, takes no bindings
      const rows = bindings.length || /^\s*select/i.test(query)
        ? db.prepare(query).all(...bindings)
        : (db.exec(query), [])
      return { toArray: () => rows, one: () => rows[0] }
    }
  }
  const storage = {
    sql,
    getAlarm:    async () => alarm,
    setAlarm:    async (at: number | Date) => void (alarm = +at),
    deleteAlarm: async () => void (alarm = null),
    deleteAll:   async () => {
      db = new DatabaseSync(":memory:")
    }
  }
  return {
    state: { storage, blockConcurrencyWhile: <T,>(run: () => Promise<T>) => run() } as unknown as DurableObjectState,
    alarm: () => alarm,
    /** Every row of a table, or none once it's gone */
    rows:  (table: string) => {
      try {
        return db.prepare(`select * from ${table}`).all()
      }
      catch {
        return []
      }
    }
  }
}

/** A namespace of objects of a class, one per name, each with its state to look into */
export const durableNamespace = <T extends DurableObject>(make: (state: DurableObjectState) => T) => {
  const objects = new Map<string, { object: T, state: ReturnType<typeof durableState> }>()
  const objectOf = (name: string) => {
    if (!objects.has(name)) {
      const state = durableState()
      objects.set(name, { object: make(state.state), state })
    }
    return objects.get(name)!
  }
  const namespace = {
    idFromName: (name: string) => name,
    get:        (name: string) => ({ fetch: (input: string, init?: RequestInit) => objectOf(name).object.fetch!(new Request(input, init)) })
  } as unknown as DurableObjectNamespace
  return { namespace, objectOf, objects }
}
