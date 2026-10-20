/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { URL } from "node:url"
import { test, expect } from "vitest"
import { d1 } from "./d1.mts"

const MIGRATIONS = new URL("../../worker/migrations/", import.meta.url)

/** The migrations in a folder, in the order wrangler applies them */
const migrationsIn = (folder: URL) =>
  readdirSync(folder).filter(name => name.endsWith(".sql")).sort().map(name => readFileSync(new URL(name, folder), "utf8"))

/** Every table and index, with each table's columns as SQLite has them */
const schemaOf = (db: DatabaseSync) =>
  Object.fromEntries(db.prepare("select type, name, tbl_name from sqlite_master where name not like 'sqlite_%' order by name").all().map(({ type, name, tbl_name }) => [
    name,
    type === "table" ? db.prepare(`select name, type, "notnull", pk from pragma_table_info(?)`).all(name) : `index on ${tbl_name}`
  ]))

test("the migrations take the database the deployed Worker has to the one this Worker declares, numbering its models' rows by day, and the Worker before keeps storing models between", () => {
  const db = new DatabaseSync(":memory:")
  const [deployed, pending] = [migrationsIn(MIGRATIONS).slice(0, 2), migrationsIn(MIGRATIONS).slice(2)]
  for (const sql of deployed)
    db.exec(sql)
  const store = db.prepare("insert into models (name, through, state) values (?, ?, '{}')")
  for (const [name, through] of [["buses", "2026-10-09"], ["buses", "2026-10-07"], ["laundry", "2026-10-08"], ["buses", "2026-10-08"]])
    store.run(name, through)
  for (const sql of pending)
    db.exec(sql)
  const rows = db.prepare("select name, through, revision, written from models order by name, written").all()
  expect(rows.map(({ name, through, written }) => [name, through, written])).toEqual([
    ["buses", "2026-10-07", 1], ["buses", "2026-10-08", 2], ["buses", "2026-10-09", 3], ["laundry", "2026-10-08", 1]
  ])
  expect(new Set(rows.map(({ revision }) => revision)).size).toBe(rows.length)
  // What the Worker before stores between migrating and deploying is numbered before every write, so never the latest
  store.run("buses", "2026-10-10")
  expect(db.prepare("select through from models where name = 'buses' order by written desc limit 1").get()).toEqual({ through: "2026-10-09" })
  // Once that Worker is gone, what's held back until then
  for (const sql of migrationsIn(new URL("after-deploy/", MIGRATIONS)))
    db.exec(sql)
  expect(schemaOf(db)).toEqual(schemaOf(d1().sqlite))
})
