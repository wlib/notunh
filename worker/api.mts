// The few requests that reach the Worker: the build's token-gated rows and models, public health, the laundry
// page's rooms, and the laundry page under each room's own address. Every other page and asset is served without it

import { Hono } from "hono/tiny"
import { bearerAuth } from "hono/bearer-auth"
import { timingSafeEqual } from "hono/utils/buffer"
import { sValidator } from "@hono/standard-validator"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { drizzle } from "drizzle-orm/d1"
import * as v from "valibot"
import { ROOMS, roomAtSlug } from "../src/laundry/rooms.mts"
import { Day } from "../src/shared/time.mts"
import { describeIssues } from "../src/shared/json.mts"
import type { Env } from "./collect.mts"
import { ROWS, health, maxRows, read, storage, write } from "./rows.mts"
import { STORED, latestModel, saveModel, throughsOf } from "./models.mts"
import { room, rooms } from "./laundry.mts"

type Worker = { Bindings: Env }

export const app = new Hono<Worker>()

/** Only the build, by BUILD_TOKEN, which with none set is nobody */
const isBuild = bearerAuth<Worker>({
  verifyToken: async (token, c) => Boolean(c.env.BUILD_TOKEN) && timingSafeEqual(token, c.env.BUILD_TOKEN!)
})

app.use("/api/rows/*", isBuild)
app.use("/api/models/*", isBuild)
app.use("/api/storage", isBuild)

/** A body as a schema makes it, or a 400 saying what's wrong with it */
const body = <S extends StandardSchemaV1,>(schema: S) =>
  sValidator("json", schema, (result, c) => result.success ? undefined : c.text(describeIssues(result.error), 400))

const entryOf = (name: string) =>
  Object.hasOwn(ROWS, name) ? ROWS[name] : undefined

app.get("/api/health", async c =>
  c.json(await health(c.env), 200, { "cache-control": "no-store" })
)

// Counting every row reads every row, so only on demand, and only the build's
app.get("/api/storage", async c =>
  c.json(await storage(c.env), 200, { "cache-control": "no-store" })
)

app.get("/api/rows/:name", async c => {
  const entry = entryOf(c.req.param("name"))
  return entry
    ? c.json(await read(c.env, entry, c.req.query("day"), Number(c.req.query("after") ?? 0)))
    : c.notFound()
})

// Rows to store, as many as a write takes, and the day to clear first, if any, for each table the build writes
for (const [name, entry] of Object.entries(ROWS))
  if (entry.row)
    app.post(`/api/rows/${name}`, body(v.object({ rows: v.pipe(v.array(entry.row), v.maxLength(maxRows(entry))), clear: v.optional(Day) })), async c => {
      const { rows, clear } = c.req.valid("json")
      await write(c.env, entry, rows, clear)
      return c.body(null, 204)
    })

// The latest stored, or the latest through a day, with its revision, and every day the name is stored through
app.get("/api/models/:name", async c => {
  const name = c.req.param("name")
  if (!STORED.includes(name))
    return c.notFound()
  const db = drizzle(c.env.DB)
  const [[model], days] = await db.batch([latestModel(db, name, c.req.query("through") as Day | undefined), throughsOf(db, name)])
  return c.json({ state: model?.state ?? null, revision: model?.revision ?? null, throughs: days.map(({ through }) => through) })
})

// Stores a state through a day if the latest is still the one the writer expects, by its revision or null for none, else 409
app.post("/api/models/:name", body(v.object({ expect: v.nullable(v.string()), state: v.looseObject({ through: Day }) })), async c => {
  const name = c.req.param("name")
  if (!STORED.includes(name))
    return c.notFound()
  const { expect, state } = c.req.valid("json")
  return await saveModel(drizzle(c.env.DB), name, state.through, state, expect)
    ? c.body(null, 204)
    : c.text("Stored by another build since it was read", 409)
})

app.get("/api/laundry/rooms", c =>
  rooms(c.req.raw, c.env)
)

app.get("/api/laundry/rooms/:id", c => {
  const id = c.req.param("id")
  return ROOMS.some(room => room.id === id) ? room(c.req.raw, c.env, id) : c.notFound()
})

// The laundry page, which opens the room its address names
app.get("/laundry/:room/", c =>
  roomAtSlug(c.req.param("room")) ? c.env.ASSETS.fetch(new URL("/laundry/", c.req.url)) : c.notFound()
)

// Whatever else reaches the Worker, as the assets would answer it
app.notFound(c =>
  c.env.ASSETS.fetch(c.req.raw)
)
