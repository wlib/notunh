// What's booked in the rooms 25Live books, a day at a time, which has no CORS, so pages ask here
// (src/courses/bookings.mts). Only the spaces the served build bundles are asked about, so nobody can have it ask
// 25Live anything else. A day of them takes 25Live seconds, so its answer is shared at the edge for ten minutes; one
// space's is quick, asked as someone opens its page or goes to reserve it, so it's shared for 30 seconds. What's
// shared is 25Live's word with every title, under a key no request reaches, and never leaves as it is: each answer
// is made from it for whoever asks, with titles only for a device with a verified UNH address, and is private to them

import { Hono } from "hono/tiny"
import type { Context } from "hono"
import * as v from "valibot"
import { type Booked, RoomsData, bookingsFrom, isAskable, reservationsUrl, shownTo } from "../src/courses/bookings.mts"
import { Day } from "../src/shared/time.mts"
import { getJson } from "../src/shared/json.mts"
import { HEADERS } from "./collect.mts"
import type { Env } from "./env.mts"
import { isVerifiedAsker } from "./social.mts"
import { named } from "./site.mts"

type Worker = { Bindings: Env }

export const rooms = new Hono<Worker>()

/** Seconds a day's answer, one space's, and 25Live's failing to answer are shared at the edge */
const DAY_SECONDS    = 600
const SPACE_SECONDS  = 30
const FAILED_SECONDS = 30

/** 25Live answering slower than this has stalled */
const UPSTREAM_MS = 20_000

/** 25Live's spaces the served build bundles, by id, which are all that's ever asked of it */
const bundled = (env: Env) =>
  named(env.ASSETS, "rooms", RoomsData).then(({ spaces }) => spaces.filter(space => space.source === "25live").map(space => space.id))

/** 25Live's word on a day, of some spaces, from the edge's cache while fresh, else asked and cached, its failing too, briefly, so a stalled 25Live holds up one ask rather than every one */
const upstream = async (origin: string, day: Day, spaces: readonly string[], seconds: number): Promise<Booked> => {
  const key = new Request(`${origin}/__rooms/${day}/${spaces.length === 1 ? spaces[0] : ""}`)
  const hit = await caches.default.match(key)
  if (hit) {
    const cached = await hit.json<Booked | { failed: true }>()
    if ("failed" in cached)
      throw new Error(`25Live failed on ${day} lately`)
    return cached
  }
  const fetched = Date.now()
  try {
    const json = await getJson(reservationsUrl(day, spaces), { headers: HEADERS, signal: AbortSignal.timeout(UPSTREAM_MS) })
    const booked: Booked = { day, fetched, bookings: bookingsFrom(json) }
    await caches.default.put(key, Response.json(booked, { headers: { "cache-control": `public, s-maxage=${seconds}` } }))
    return booked
  }
  catch (error) {
    await caches.default.put(key, Response.json({ failed: true }, { headers: { "cache-control": `public, s-maxage=${FAILED_SECONDS}` } }))
    throw error
  }
}

/** A day's bookings, of the build's spaces or of one of them, as said to whoever's asking */
const answer = async (c: Context<Worker>, day: string, space?: string) => {
  if (!v.is(Day, day) || !isAskable(day, Date.now()))
    return c.notFound()
  const spaces = await bundled(c.env).catch(error => (console.warn(error), undefined))
  if (!spaces)
    return c.text("No rooms to book in this build", 502)
  if (space !== undefined && !spaces.includes(space))
    return c.notFound()
  const [booked, isVerified] = await Promise.all([
    upstream(new URL(c.req.url).origin, day, space === undefined ? spaces : [space], space === undefined ? DAY_SECONDS : SPACE_SECONDS).catch(error => (console.warn(error), undefined)),
    isVerifiedAsker(c)
  ])
  if (!booked)
    return c.text("25Live didn't answer", 502)
  return c.json({ ...booked, bookings: shownTo(booked.bookings, isVerified) } satisfies Booked, 200, { "cache-control": "private, no-store" })
}

rooms.get("/api/rooms/:day", c =>
  answer(c, c.req.param("day"))
)

rooms.get("/api/rooms/:day/:space", c =>
  answer(c, c.req.param("day"), c.req.param("space"))
)
