/// <reference types="node" />
// The rooms' routes (worker/rooms.mts): a day's bookings, and one room's, from 25Live through the edge's cache, said
// with study groups' titles only to a device with a verified UNH address, private to whoever asked, never with who
// booked; and only for days around now

import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { app } from "../../worker/api.mts"
import type { Env } from "../../worker/env.mts"
import type { Message } from "../../worker/mail.mts"
import { type Booked, isPersonal } from "../../src/courses/bookings.mts"
import { addDays, localDay } from "../../src/shared/time.mts"
import { d1 } from "./d1.mts"

const fixture = async (path: string) => JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), "../fixtures", path), "utf8"))
const RESERVATIONS = await fixture("rooms/reservations.json")
const ROOMS = await fixture("data/src/map/rooms.json")
/** The map page as built, naming its rooms */
const MAP = `<!doctype html><html><head><meta name="release" content="2026-10-28T08:00:00.000Z"><link rel="data" href="/assets/rooms-x.json" data-name="rooms"></head><body></body></html>`

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const cache = () => {
  const entries = new Map<string, Response>()
  return {
    entries,
    match: async (request: Request) => entries.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => void entries.set(request.url, response)
  }
}

/** A Worker with a fresh database and mailer, an edge cache, and 25Live answering with the fixture's day, or failing */
const worker = ({ isUp = true } = {}) => {
  const sent: Message[] = []
  const asked: string[] = []
  const edge = cache()
  vi.stubGlobal("caches", { default: edge })
  vi.stubGlobal("fetch", async (input: string | URL) => {
    asked.push(String(input))
    if (!isUp)
      return new Response("", { status: 503 })
    const spaces = new URL(input).searchParams.get("space_id")!.split(" ")
    return Response.json({ space_reservations: { space_reservation: RESERVATIONS.space_reservations.space_reservation.filter((reservation: { spaces: { space_id: number } }) => spaces.includes(String(reservation.spaces.space_id))) } })
  })
  const env = {
    DB: d1(),
    ASSETS: {
      fetch: async (input: RequestInfo | URL) => {
        const { pathname } = new URL(input instanceof Request ? input.url : input)
        return pathname === "/map/" ? new Response(MAP, { headers: { "content-type": "text/html" } }) : pathname === "/assets/rooms-x.json" ? Response.json(ROOMS) : new Response("", { status: 404 })
      }
    },
    EMAIL: { send: async ({ to, subject, text }: Message) => (sent.push({ to, subject, text }), { messageId: `test-${sent.length}` }) }
  } as unknown as Env
  const device = (name: string) => {
    const id = name.padEnd(16, "_")
    const secret = `secret-of-${id}`
    const command = (path: string, body: object) => app.fetch(new Request(`https://notunh.app${path}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ device: id, ...body }) }), env)
    const read = (path: string) => app.fetch(new Request(`https://notunh.app${path}?device=${id}`, { headers: { authorization: `Bearer ${secret}` } }), env)
    /** Verifies a UNH address, as typing back the code emailed does */
    const verify = async (address: string) => {
      await command("/api/email", { address })
      await command("/api/email/verify", { address, code: sent.at(-1)!.subject.slice(0, 6) })
    }
    return { id, command, read, verify }
  }
  const anyone = (path: string, init?: RequestInit) => app.fetch(new Request(`https://notunh.app${path}`, init), env)
  return { env, asked, edge, device, anyone }
}

const today = localDay(Date.now())

test("anyone's told a day's bookings without titles or students' names, and never who booked, privately", async () => {
  const { anyone } = worker()
  const response = await anyone(`/api/rooms/${today}`)
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("private, no-store")
  const text = await response.text()
  expect(text).not.toMatch(/abc\d{4}|staff\d|"title"|\(Private\)|Durham - Student/)
  const { day, bookings } = JSON.parse(text) as Booked
  expect(day).toBe(today)
  expect(bookings.length).toBeGreaterThan(0)
  expect(bookings.some(booking => booking.org === "Tau Kappa Epsilon")).toBe(true)
})

test("a device of a person with a verified UNH address is told every title but no student's own organization, and one without isn't, as itself or by its cookie", async () => {
  const { env, device, anyone } = worker()
  const ana = device("ana")
  await ana.verify("ana@unh.edu")
  const bo = device("bo")
  await bo.command("/api/email", { address: "bo@unh.edu" })
  const titles = async (response: Response) => (await response.json<Booked>()).bookings.map(booking => booking.title)
  expect((await titles(await ana.read(`/api/rooms/${today}`))).every(Boolean)).toBe(true)
  expect((await titles(await bo.read(`/api/rooms/${today}`))).every(title => title === undefined)).toBe(true)
  expect((await (await ana.read(`/api/rooms/${today}`)).json<Booked>()).bookings.some(booking => booking.org !== undefined && isPersonal(booking))).toBe(false)
  // The cookie that keeps a device's credential says it's that device, and a made-up secret isn't
  expect((await titles(await anyone(`/api/rooms/${today}`, { headers: { cookie: `notunh-device=${ana.id}.secret-of-${ana.id}` } }))).every(Boolean)).toBe(true)
  expect((await titles(await anyone(`/api/rooms/${today}?device=${ana.id}`, { headers: { authorization: "Bearer not-ana-s-secret-at-all" } }))).some(Boolean)).toBe(false)
  // Reading never makes a device of whoever asks
  const cy = "cy".padEnd(16, "_")
  await anyone(`/api/rooms/${today}?device=${cy}`, { headers: { authorization: `Bearer secret-of-${cy}` } })
  expect(await env.DB.prepare("select id from devices where id = ?").bind(cy).first()).toBeNull()
})

test("whoever's asking, nothing the edge shares is answered as it is, and titles reach only the verified", async () => {
  const { device, anyone } = worker()
  const ana = device("ana")
  await ana.verify("ana@unh.edu")
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }), async asks => {
    for (const isAna of asks) {
      const text = await (await (isAna ? ana.read(`/api/rooms/${today}`) : anyone(`/api/rooms/${today}`))).text()
      expect(text).not.toMatch(/abc\d{4}/)
      expect(/"title"/.test(text)).toBe(isAna)
    }
  }), { numRuns: 10 })
})

test("a day is asked of 25Live once in ten minutes, and a room on its own, which is asked as itself", async () => {
  const { anyone, asked } = worker()
  await anyone(`/api/rooms/${today}`)
  await anyone(`/api/rooms/${today}`)
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain(`start_dt=${today.replaceAll("-", "")}`)
  const room = await (await anyone(`/api/rooms/${today}/532`)).json<Booked>()
  expect(asked).toHaveLength(2)
  expect(asked[1]).toContain("space_id=532&")
  expect(room.bookings.length).toBeGreaterThan(0)
  expect(room.bookings.every(booking => booking.space === "532")).toBe(true)
  await anyone(`/api/rooms/${today}/532?again=1`)
  expect(asked).toHaveLength(2)
})

test("only days around now, and the map's rooms, are asked of 25Live, and of a day only the map's rooms", async () => {
  const { anyone, asked } = worker()
  // Campus Rec's facilities are the build's alone, and never asked of 25Live
  const court = ROOMS.spaces.find(({ source }: { source: string }) => source === "rec").id
  for (const path of [`/api/rooms/${addDays(today, 60)}`, `/api/rooms/${addDays(today, -5)}`, "/api/rooms/tomorrow", `/api/rooms/${today}/abc`, `/api/rooms/${today}/1234567`, `/api/rooms/${today}/999999`, `/api/rooms/${today}/${court}`])
    expect((await anyone(path)).status).toBe(404)
  expect(asked).toHaveLength(0)
  const { bookings } = await (await anyone(`/api/rooms/${today}`)).json<Booked>()
  const placed = new Set(ROOMS.spaces.filter(({ source }: { source: string }) => source === "25live").map(({ id }: { id: string }) => id))
  expect(bookings.every(({ space }) => placed.has(space))).toBe(true)
  expect(new URL(asked[0]).searchParams.get("space_id")!.split(" ")).toHaveLength(placed.size)
})

test("25Live failing says so, and isn't asked again by everyone at once", async () => {
  const { anyone, asked } = worker({ isUp: false })
  expect((await anyone(`/api/rooms/${today}`)).status).toBe(502)
  expect((await anyone(`/api/rooms/${today}`)).status).toBe(502)
  expect(asked).toHaveLength(1)
})
