// The few requests that reach the Worker: the build's token-gated rows, models, timetables, and what it derives,
// public health, the laundry page's rooms, and the laundry page under each room's own address. Every other page and
// asset is served without it

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
import { ROWS, health, read, storage } from "./rows.mts"
import { STORED, acquireFeed, feedJson, feedList, latestModel, saveModel } from "./models.mts"
import { DERIVED, commit, derivedOf, putPart } from "./derived.mts"
import { room, rooms } from "./laundry.mts"

type Worker = { Bindings: Env }

export const app = new Hono<Worker>()

/** Only the build, by BUILD_TOKEN, which with none set is nobody */
const isBuild = bearerAuth<Worker>({
  verifyToken: async (token, c) => Boolean(c.env.BUILD_TOKEN) && timingSafeEqual(token, c.env.BUILD_TOKEN!)
})

// Every route under /api/ but health and laundry's
app.use("/api/*", (c, next) => /^\/api\/(health$|laundry\/)/.test(c.req.path) ? next() : isBuild(c, next))

/** Part of a request as a schema makes it, its JSON body by default, or a 400 saying what's wrong with it */
const valid = <S extends StandardSchemaV1, T extends "json" | "form" | "query" | "param" = "json">(schema: S, target = "json" as T) =>
  sValidator(target, schema, (result, c) => result.success ? undefined : c.text(describeIssues(result.error), 400))

const entryOf = (name: string) =>
  Object.hasOwn(ROWS, name) ? ROWS[name] : undefined

const isDerived = (name: string): name is keyof typeof DERIVED =>
  Object.hasOwn(DERIVED, name)

const SHA256 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))
const GENERATION = v.pipe(v.string(), v.uuid())
const PART = v.pipe(v.string(), v.digits(), v.transform(Number))

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

// The latest stored, with its revision
app.get("/api/models/:name", async c => {
  const name = c.req.param("name")
  if (!STORED.includes(name))
    return c.notFound()
  const [model] = await latestModel(drizzle(c.env.DB), name)
  return c.json({ state: model?.state ?? null, revision: model?.revision ?? null })
})

// Stores a state through a day if the latest is still the one the writer expects, by its revision or null for none, else 409
app.post("/api/models/:name", valid(v.object({ expect: v.nullable(v.string()), state: v.looseObject({ through: Day }) })), async c => {
  const name = c.req.param("name")
  if (!STORED.includes(name))
    return c.notFound()
  const { expect, state } = c.req.valid("json")
  return await saveModel(drizzle(c.env.DB), name, state.through, state, expect)
    ? c.body(null, 204)
    : c.text("Stored by another build since it was read", 409)
})

// Every timetable acquired, the earliest first, and one by its id, as its JSON
app.get("/api/feeds", async c =>
  c.json(await feedList(drizzle(c.env.DB)))
)

app.get("/api/feeds/:id", async c => {
  const feed = await feedJson(drizzle(c.env.DB), c.req.param("id"))
  return feed === undefined ? c.notFound() : c.body(feed, 200, { "content-type": "application/json" })
})

// A timetable the build has, as a form of what the feed says of itself and its two files, acquired now unless it's
// the one last acquired
const Acquired = v.object({
  id:       SHA256,
  source:   SHA256,
  version:  v.string(),
  start:    v.union([Day, v.literal("")]),
  end:      v.union([Day, v.literal("")]),
  feed:     v.instance(File),
  original: v.instance(File)
})
app.post("/api/feeds", valid(Acquired, "form"), async c => {
  const { feed, original, ...about } = c.req.valid("form")
  const acquired = await acquireFeed(drizzle(c.env.DB), { ...about, feed: await feed.text(), original: new Uint8Array(await original.arrayBuffer()) }, Date.now())
  return c.json({ acquired })
})

// What's derived from a day by a name, as its last committed generation, or null while there's none
app.get("/api/derived/:name", valid(v.object({ day: Day }), "query"), async c => {
  const name = c.req.param("name")
  return isDerived(name) ? c.json(await derivedOf(c.env.DB, name, c.req.valid("query").day) ?? null) : c.notFound()
})

// A part of a generation, as its bytes, and the manifest that commits a generation once all its parts are stored,
// else 409
app.put("/api/chunks/:generation/:part", valid(v.object({ generation: GENERATION, part: PART }), "param"), async c => {
  const { generation, part } = c.req.valid("param")
  const body = new Uint8Array(await c.req.arrayBuffer())
  if (!body.length)
    return c.text("A part has bytes", 400)
  await putPart(drizzle(c.env.DB), generation, part, body)
  return c.body(null, 204)
})

app.post("/api/derived/:name", valid(v.object({ day: Day, identity: v.string(), generation: GENERATION, parts: v.pipe(v.number(), v.integer(), v.minValue(1)) })), async c => {
  const name = c.req.param("name")
  if (!isDerived(name))
    return c.notFound()
  const { day, ...manifest } = c.req.valid("json")
  return await commit(c.env.DB, name, day, manifest)
    ? c.body(null, 204)
    : c.text("Not every part of the generation is stored", 409)
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
