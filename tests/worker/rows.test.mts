import { test, expect } from "vitest"
import fc from "fast-check"
import { getTableColumns } from "drizzle-orm"
import { chunks, inserts } from "../../worker/rows.mts"
import { latest, transitions } from "../../worker/schema.mts"
import { d1 } from "./d1.mts"

const status = fc.constantFrom("free" as const, "running" as const, "done" as const, "out" as const)

const machine = fc.record({
  machine:   fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"),
  room:      fc.constantFrom("r1", "r2"),
  kind:      fc.constantFrom("washer" as const, "dryer" as const),
  number:    fc.constantFrom("1", "2", "3"),
  model:     fc.constant("SWNNY2SP115TW01"),
  stack:     fc.option(fc.constantFrom("upper" as const, "lower" as const), { nil: undefined }),
  status,
  raw:       fc.constantFrom("AVAILABLE", "IN_USE", "COMPLETE"),
  at:        fc.integer({ min: 0, max: 1e12 }),
  reported:  fc.integer({ min: 0, max: 1e12 }),
  remaining: fc.integer({ min: 0, max: 7200 }),
  cycle:     fc.option(fc.constantFrom("Normal", "Heavy"), { nil: undefined })
})

/** A row as D1 would return it, with what was left out null */
const stored = (row: typeof latest.$inferInsert) =>
  Object.fromEntries(Object.keys(getTableColumns(latest)).map(name => [name, (row as Record<string, unknown>)[name] ?? null]))

test("rows insert as few statements as D1's bound parameters allow, each within them, replacing a row with the same key", () =>
  fc.assert(fc.asyncProperty(fc.array(machine, { maxLength: 40 }), fc.array(machine, { maxLength: 40 }), async (first, second) => {
    const db = d1()
    for (const rows of [first, second]) {
      const statements = inserts(db, latest, rows, [latest.machine])
      expect(statements).toHaveLength(chunks(latest, rows).length)
      expect(statements).toHaveLength(Math.ceil(rows.length / 8))
      if (rows.length)
        await db.batch(statements)
    }
    const expected = new Map([...first, ...second].map(row => [row.machine, stored(row)]))
    const written = db.sqlite.prepare("select * from latest").all()
    expect(new Map(written.map(row => [row.machine, row]))).toEqual(expected)
  }))
)

test("a table without a key takes every row, and one over the parameters splits", () => {
  const db = d1()
  const rows = Array.from({ length: 29 }, (_, i) => ({ machine: `m${i}`, room: "r", at: i, status: "free" as const, raw: "AVAILABLE", remaining: 0 }))
  const statements = inserts(db, transitions, rows)
  expect(statements).toHaveLength(3)
  expect(chunks(transitions, rows).map(chunk => chunk.length)).toEqual([14, 14, 1])
})
