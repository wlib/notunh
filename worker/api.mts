// The few requests that reach the Worker: the build's token-gated rows and models, public health, the laundry
// page's rooms, and the laundry page under each room's own address. Every other page and asset is served without it

import { Hono } from "hono/tiny"
import { bearerAuth } from "hono/bearer-auth"
import { timingSafeEqual } from "hono/utils/buffer"
import { drizzle } from "drizzle-orm/d1"
import { ROOMS, roomAtSlug } from "../src/laundry/rooms.mts"
import type { Day } from "../src/shared/time.mts"
import type { Env } from "./collect.mts"
import { ROWS, health, maxRows, read, write } from "./rows.mts"
import { MODELS, latestModel, saveModel } from "./models.mts"
import { room, rooms } from "./laundry.mts"

type Worker = { Bindings: Env }

export const app = new Hono<Worker>()

/** Only the build, by BUILD_TOKEN, which with none set is nobody */
const isBuild = bearerAuth<Worker>({
  verifyToken: async (token, c) => Boolean(c.env.BUILD_TOKEN) && timingSafeEqual(token, c.env.BUILD_TOKEN!)
})

app.use("/api/rows/*", isBuild)
app.use("/api/models/*", isBuild)

const entryOf = (name: string) =>
  Object.hasOwn(ROWS, name) ? ROWS[name] : undefined

app.get("/api/health", async c =>
  c.json(await health(c.env), 200, { "cache-control": "no-store" })
)

app.get("/api/rows/:name", async c => {
  const entry = entryOf(c.req.param("name"))
  return entry
    ? c.json(await read(c.env, entry, c.req.query("day"), Number(c.req.query("after") ?? 0)))
    : c.notFound()
})

app.post("/api/rows/:name", async c => {
  const entry = entryOf(c.req.param("name"))
  if (!entry?.canWrite)
    return c.notFound()
  const { rows, clear } = await c.req.json<{ rows: Record<string, unknown>[], clear?: Day }>()
  if (!Array.isArray(rows) || rows.length > maxRows(entry))
    return c.text(`Needs up to ${maxRows(entry)} rows`, 400)
  await write(c.env, entry, rows, clear)
  return c.body(null, 204)
})

app.get("/api/models/:name", async c => {
  const name = c.req.param("name")
  if (!MODELS.includes(name))
    return c.notFound()
  const [model] = await latestModel(drizzle(c.env.DB), name)
  return c.json({ state: model?.state ?? null })
})

app.post("/api/models/:name", async c => {
  const name = c.req.param("name")
  if (!MODELS.includes(name))
    return c.notFound()
  const state = await c.req.json<{ through?: unknown }>()
  if (typeof state?.through !== "string")
    return c.text("Needs a model through a day", 400)
  const db = drizzle(c.env.DB)
  await db.batch(saveModel(db, name, state.through, state))
  return c.body(null, 204)
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
