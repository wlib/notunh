// The few requests that reach the Worker: learning's and archiving's token-gated rows, models, timetables, and what
// learning derives, public health, the laundry page's rooms, the laundry page under each room's own address,
// devices' reminders, each device's own by its secret, the social routes (social.mts), and the pages a shared link
// opens, pins' and the map's, with their previews (preview.mts). Every other page and asset is served without it

import { Hono } from "hono/tiny"
import type { MiddlewareHandler } from "hono"
import { bearerAuth } from "hono/bearer-auth"
import { timingSafeEqual } from "hono/utils/buffer"
import { sValidator } from "@hono/standard-validator"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { drizzle } from "drizzle-orm/d1"
import * as v from "valibot"
import { ROOMS } from "../src/laundry/rooms.mts"
import { Day } from "../src/shared/time.mts"
import { describeIssues } from "../src/shared/json.mts"
import type { Env } from "./env.mts"
import { ROWS, health, read, storage } from "./rows.mts"
import { MODELS, acquireFeed, feedJson, feedList, latestModel, saveModel } from "./models.mts"
import { DERIVED, commit, derivedOf, putPart } from "./derived.mts"
import { room, rooms } from "./laundry.mts"
import { type Ask, Setting, vapidOf } from "./reminders.mts"
import { social } from "./social.mts"
import { previews } from "./preview.mts"
import { rooms as bookings } from "./rooms.mts"

type Worker = { Bindings: Env }

export const app = new Hono<Worker>()

/** Only the workflows, by BUILD_TOKEN, which with none set is nobody */
const isBuild = bearerAuth<Worker>({
  verifyToken: async (token, c) => Boolean(c.env.BUILD_TOKEN) && timingSafeEqual(token, c.env.BUILD_TOKEN!)
})

// Every route under /api/ but health, laundry's, the rooms', reminders', and the social routes, which go by each device's own secret
app.use("/api/*", (c, next) => /^\/api\/(health$|laundry\/|rooms\/|push\/|reminders\/|pins|link|email|me$|state$|session$)/.test(c.req.path) ? next() : isBuild(c, next))

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

// Counting every row reads every row, so only on demand, and only the workflows'
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
  if (!MODELS.includes(name))
    return c.notFound()
  const [model] = await latestModel(drizzle(c.env.DB), name)
  return c.json({ state: model?.state ?? null, revision: model?.revision ?? null })
})

// Stores a state through a day if the latest is still the one the writer expects, by its revision or null for none, else 409
app.post("/api/models/:name", valid(v.object({ expect: v.nullable(v.string()), state: v.looseObject({ through: Day }) })), async c => {
  const name = c.req.param("name")
  if (!MODELS.includes(name))
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

// A timetable learning has, as a form of what the feed says of itself and its two files, acquired now unless it's
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

// Reminders: the public key pages subscribe to pushes with, and each device's reminders, kept by its Durable Object
// (reminders.mts) and reached by its id, given its secret. Where they aren't set up, as in Previews, there's none
const ID = v.pipe(v.string(), v.regex(/^[\w-]{16,64}$/))

/** A device's Durable Object, asked something, or 404 where reminders aren't set up */
const ask = (env: Env, device: string, asked: Ask) =>
  env.REMINDERS && vapidOf(env)
    ? env.REMINDERS.get(env.REMINDERS.idFromName(device)).fetch("https://reminders/", { method: "POST", body: JSON.stringify(asked) })
    : new Response("Reminders aren't set up here", { status: 404 })

/** The device's secret, as a bearer token */
const secretOf = (header: string | undefined) =>
  header?.match(/^Bearer (\S{16,200})$/)?.[1]

/**
 * Only so many reminders set a minute from one address, by the Rate Limiting binding where it's bound, since any
 * client can mint device ids and each is an object of its own. Counted per Cloudflare location, so it bounds one
 * client's minting rather than accounting exactly
 */
const limited: MiddlewareHandler<Worker> = async (c, next) => {
  const address = c.req.header("cf-connecting-ip")
  if (c.env.RATE_LIMIT && address && !(await c.env.RATE_LIMIT.limit({ key: address })).success)
    return c.text("Too many reminders set from here; try again in a minute", 429)
  return next()
}

app.get("/api/push/key", c => {
  const vapid = vapidOf(c.env)
  return vapid && c.env.REMINDERS ? c.json({ key: vapid.publicKey }) : c.text("Reminders aren't set up here", 404)
})

app.put("/api/reminders/:id", limited, valid(v.object({ id: ID }), "param"), valid(v.object({ device: ID, ...Setting.entries })), c => {
  const secret = secretOf(c.req.header("authorization"))
  const { device, ...setting } = c.req.valid("json")
  return secret ? ask(c.env, device, { kind: "set", id: c.req.valid("param").id, secret, ...setting }) : c.text("No secret", 401)
})

app.delete("/api/reminders/:id", valid(v.object({ id: ID }), "param"), valid(v.object({ device: ID }), "query"), c => {
  const secret = secretOf(c.req.header("authorization"))
  return secret ? ask(c.env, c.req.valid("query").device, { kind: "cancel", id: c.req.valid("param").id, secret }) : c.text("No secret", 401)
})

app.delete("/api/push/devices/:device", valid(v.object({ device: ID }), "param"), c => {
  const secret = secretOf(c.req.header("authorization"))
  return secret ? ask(c.env, c.req.valid("param").device, { kind: "forget", secret }) : c.text("No secret", 401)
})

// What's booked in the rooms 25Live books, said to each asker as they may see it (rooms.mts)
app.route("/", bookings)

// Pins, marks, device links and email verification (social.mts)
app.route("/", social)

// The pages a shared link or a search opens, pins', the map's and laundry rooms', each headed and summarized as what
// it's of, and their cards (preview.mts)
app.route("/", previews)

// Whatever else reaches the Worker, as the assets would answer it
app.notFound(c =>
  c.env.ASSETS.fetch(c.req.raw)
)
