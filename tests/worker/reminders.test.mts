import { test, expect, vi, beforeEach, afterEach } from "vitest"
import fc from "fast-check"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { app } from "../../worker/api.mts"
import { FORGET_MS, MAX_REMINDERS, Reminders, WINDOW_MS } from "../../worker/reminders.mts"
import { samples } from "../../worker/schema.mts"
import { inserts } from "../../worker/rows.mts"
import { FURTHEST, GONE, LATEST, MAX_PUSHES, MAX_TRIES, MIN_CHECK, type Watch, Wake } from "../../src/reminders/watch.mts"
import { emptyModel } from "../../src/transit/models/model.mts"
import { gzipJson } from "../../src/shared/json.mts"
import type { Env } from "../../worker/collect.mts"
import { d1 } from "./d1.mts"
import { durableNamespace } from "./durable.mts"
import { browser, vapidKeys } from "./webpush.mts"
import * as v from "valibot"

// Half an hour of the Worker's samples on a Wednesday afternoon (tests/map/replay.test.mts), stored as the crons store
// them, with a route 3 bus on its way to Thompson Hall (stop 209), due at 18:31 UTC and leaving at 18:40
const { feed, rows }: { feed: unknown, rows: { source: string, at: number, body: unknown[] }[] } =
  JSON.parse(gunzipSync(readFileSync(decodeURIComponent(new URL("../map/fixtures/buses.json.gz", import.meta.url).pathname))).toString())
const NOW = Date.UTC(2026, 9, 7, 18, 18)
const DEVICE = "device-aaaaaaaaaaaaaaaa"
const SECRET = "secret-bbbbbbbbbbbbbbbb"
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc"
const ID = "reminder-cccccccccccccc"
const WATCH: Watch = { stop: "209", route: "3", trip: "3B FULL_T04", scheduled: 1791397860, lead: 600 }
const LEFT = 1791398421

let env: Env
let objects: ReturnType<typeof durableNamespace<Reminders>>
let phone: Awaited<ReturnType<typeof browser>>
/** Whether the site's timetable and model can be read */
let siteDown: boolean
/** Something to do while the samples are being read, as another request of the object */
let meanwhile: (() => unknown) | undefined
/** What reaches the push service, and what it answers */
let pushed: string[]
let pushStatus: number
let retryAfter: string | undefined

const send = (method: string, path: string, body?: unknown, secret?: string) =>
  app.fetch(new Request(`https://notunh.app${path}`, {
    method,
    headers: { "content-type": "application/json", ...secret ? { authorization: `Bearer ${secret}` } : {} },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env)

const setReminder = (id: string, watch: object = WATCH, secret: string | undefined = SECRET) =>
  send("PUT", `/api/reminders/${id}`, { device: DEVICE, subscription: { endpoint: ENDPOINT, keys: phone.keys }, watch }, secret)

const device = () => objects.objectOf(DEVICE)
const wakes = () => pushed.map(json => v.parse(Wake, JSON.parse(json)))

/** Runs the device's alarm at its time, as Cloudflare would */
const fire = async () => {
  const at = device().state.alarm()!
  vi.setSystemTime(Math.max(at, Date.now()))
  await device().object.alarm!()
  return at
}

/** The built site's map page and data files, as the object reads them, or nothing at all */
const ASSETS = {
  fetch: async (input: string | Request) => {
    const { pathname } = new URL(input instanceof Request ? input.url : input)
    if (siteDown)
      return new Response("", { status: 503 })
    if (pathname === "/map/")
      return new Response(`<html><head><link rel="data" href="/assets/gtfs-x.json" data-name="gtfs" /><link rel="data" href="/assets/model-x.json" data-name="model" /></head></html>`)
    if (pathname === "/assets/gtfs-x.json")
      return Response.json(feed)
    if (pathname === "/assets/model-x.json")
      return Response.json(emptyModel())
    return new Response("", { status: 404 })
  }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  phone = await browser()
  const vapid = await vapidKeys()
  const DB = d1()
  await DB.batch(inserts(DB, samples, await Promise.all(rows.map(async ({ source, at, body }) => ({ source, at, body: await gzipJson(body) })))))
  objects = durableNamespace(state => new Reminders(state, env))
  env = { DB, ASSETS, REMINDERS: objects.namespace, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey } as unknown as Env
  siteDown = false
  meanwhile = undefined
  pushed = []
  pushStatus = 201
  retryAfter = undefined
  const original = DB.prepare.bind(DB)
  DB.prepare = ((query: string) => {
    const statement = original(query)
    if (!query.startsWith("select source, at, body from samples"))
      return statement
    // Another ask of the object may come while the samples are read
    const bound = statement.bind.bind(statement)
    statement.bind = (...values: unknown[]) => {
      const prepared = bound(...values)
      const all = prepared.all.bind(prepared)
      prepared.all = async () => (await meanwhile?.(), all())
      return prepared
    }
    return statement
  }) as typeof DB.prepare
  vi.stubGlobal("fetch", async (input: Request | string) => {
    const request = input instanceof Request ? input : new Request(input)
    expect(request.url).toBe(ENDPOINT)
    expect(request.headers.get("urgency")).toBe("high")
    expect(request.headers.get("topic")).toBe(ID)
    pushed.push(await phone.decrypt(new Uint8Array(await request.arrayBuffer())))
    return new Response(null, { status: pushStatus, headers: retryAfter ? { "retry-after": retryAfter } : {} })
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test("a run is forecast from the Worker's own samples as its time nears, the phone is woken once its bus could leave within the lead, and the bus going by ends it", async () => {
  expect((await setReminder(ID)).status).toBe(204)
  // The Worker keeps the run, the stop, the lead, and the subscription: nothing of where the trip goes
  expect(JSON.parse(device().state.rows("reminders")[0].state as string)).toEqual({ ...WATCH, pushes: 0, next: NOW / 1000 })
  const checks: number[] = []
  while (device().state.alarm()! < NOW + 3600_000 && device().state.rows("reminders").length && checks.length < 100)
    checks.push(await fire())
  const [wake] = wakes()
  expect(wake.kind).toBe("due")
  // Its bus was followed on the trip, and foretold within minutes of when it left
  expect(wake.seen).toMatchObject({ status: "coming", isLive: true })
  expect(Math.abs(wake.seen.time - LEFT)).toBeLessThan(600)
  expect(wake.seen.band).toBeGreaterThanOrEqual(30)
  // Woken the lead before the bus could leave to within a check, followed until it went by, and checked on few times in all
  expect(wake.seen.time - wake.seen.band - wake.at).toBeLessThanOrEqual(WATCH.lead)
  expect(wakes().length).toBeLessThanOrEqual(3)
  expect(checks.length).toBeLessThan(50)
  expect(checks.at(-1)! / 1000).toBeGreaterThan(LEFT)
  expect(device().state.rows("reminders")).toEqual([])
  // Kept, with nothing to check, until it's gone unused for a while
  expect(device().state.alarm()).toBe(checks.at(-1)! + FORGET_MS)
  await fire()
  expect(device().state.rows("device")).toEqual([])
})

test("with the site's timetable and model out of reach, the run is due as scheduled, and the phone is still woken", async () => {
  siteDown = true
  await setReminder(ID)
  while (device().state.alarm()! < NOW + 3600_000 && device().state.rows("reminders").length)
    await fire()
  expect(wakes().map(({ kind }) => kind)).toEqual(["due"])
  expect(wakes()[0].seen).toMatchObject({ time: WATCH.scheduled, isLive: false, status: "coming" })
})

test("whatever the samples say, each check sets the alarm ahead, and the phone is told at most three times", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ ahead: fc.integer({ min: -600, max: 1800 }), siteDown: fc.boolean() }), { minLength: 1, maxLength: 40 }),
    async story => {
      vi.setSystemTime(NOW)
      objects.objects.clear()
      pushed = []
      await setReminder(ID, { ...WATCH, scheduled: NOW / 1000 + 600 + story[0].ahead })
      for (const step of story) {
        if (device().state.alarm() === null || device().state.rows("reminders").length === 0)
          break
        siteDown = step.siteDown
        const before = Date.now()
        await fire()
        expect(device().state.alarm()!).toBeGreaterThan(Math.max(before, Date.now()) - 1)
      }
      expect(pushed.length).toBeLessThanOrEqual(3)
    }
  ), { numRuns: 25 })
})

test("a push the service refuses for good forgets the device, and one it can't take now is tried again after the wait it asks for, else a doubling one", async () => {
  siteDown = true
  await setReminder(ID)
  // The bus is within the lead
  vi.setSystemTime((WATCH.scheduled - 300) * 1000)
  pushStatus = 503
  await fire()
  expect(pushed).toHaveLength(1)
  expect(device().state.rows("reminders")).toHaveLength(1)
  expect(device().state.alarm()).toBe((WATCH.scheduled - 300 + MIN_CHECK) * 1000)
  retryAfter = "90"
  await fire()
  expect(device().state.alarm()).toBe((WATCH.scheduled - 300 + MIN_CHECK + 90) * 1000)
  retryAfter = undefined
  await fire()
  expect(device().state.alarm()).toBe((WATCH.scheduled - 300 + MIN_CHECK + 90 + 4 * MIN_CHECK) * 1000)
  pushStatus = 410
  await fire()
  expect(pushed).toHaveLength(4)
  expect(device().state.rows("device")).toEqual([])
  expect(device().state.alarm()).toBeNull()
})

test("a push service that never takes a push is given up on after a few tries, whatever the run does, and the watch ends", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: -300, max: 1800 }), fc.boolean(), fc.constantFrom(429, 500, 503), async (ahead, isSiteDown, status) => {
    vi.setSystemTime(NOW)
    objects.objects.clear()
    pushed = []
    siteDown = isSiteDown
    pushStatus = status
    await setReminder(ID, { ...WATCH, scheduled: NOW / 1000 + 600 + ahead })
    let fires = 0
    while (device().state.rows("reminders").length && device().state.alarm()! < NOW + (LATEST + 7200) * 1000) {
      await fire()
      expect(++fires).toBeLessThan(200)
    }
    expect(device().state.rows("reminders")).toEqual([])
    expect(pushed.length).toBeLessThanOrEqual(MAX_PUSHES * (MAX_TRIES + 1))
  }), { numRuns: 15 })
})

test("a device forgotten on a warm object can set a reminder again, and asking an unknown device anything else leaves nothing behind", async () => {
  await setReminder(ID)
  expect((await send("DELETE", `/api/push/devices/${DEVICE}`, undefined, SECRET)).status).toBe(204)
  expect(device().state.rows("device")).toEqual([])
  expect((await setReminder(ID)).status).toBe(204)
  expect(device().state.rows("reminders")).toHaveLength(1)
  const other = "device-ffffffffffffffff"
  expect((await send("DELETE", `/api/reminders/${ID}?device=${other}`, undefined, SECRET)).status).toBe(403)
  expect((await send("DELETE", `/api/push/devices/${other}`, undefined, SECRET)).status).toBe(403)
  expect(objects.objectOf(other).state.rows("sqlite_master")).toEqual([])
  expect(objects.objectOf(other).state.alarm()).toBeNull()
})

test("the samples are read by the table's key, not by reading it through", () => {
  const plan = (env.DB as unknown as { sqlite: { prepare(sql: string): { all(...values: unknown[]): { detail: string }[] } } }).sqlite
    .prepare("explain query plan select source, at, body from samples where source in ('buses', 'predictions') and at > ? order by at").all(NOW - WINDOW_MS)
  expect(plan.map(({ detail }) => detail).join(" ")).toMatch(/USING (PRIMARY KEY|INDEX)/)
  expect(plan.map(({ detail }) => detail).join(" ")).not.toContain("SCAN")
})

test("a reminder replaced or cancelled while the samples are being read is left as the phone left it", async () => {
  await setReminder(ID)
  vi.setSystemTime((WATCH.scheduled - 300) * 1000)
  const later = { ...WATCH, scheduled: WATCH.scheduled + 7200 }
  meanwhile = () => setReminder(ID, later)
  await fire()
  expect(pushed).toEqual([])
  expect(JSON.parse(device().state.rows("reminders")[0].state as string)).toMatchObject(later)
  meanwhile = () => send("DELETE", `/api/reminders/${ID}?device=${DEVICE}`, undefined, SECRET)
  await fire()
  expect(pushed).toEqual([])
  expect(device().state.rows("reminders")).toEqual([])
  expect(device().state.alarm()).toBe(Date.now() + FORGET_MS)
})

test("a device's reminders are its own: changed or cancelled only with its secret, at most ten, forgotten when asked, and offered only where set up", async () => {
  expect(await (await send("GET", "/api/push/key")).json()).toEqual({ key: env.VAPID_PUBLIC_KEY })
  expect((await setReminder(ID)).status).toBe(204)
  expect((await setReminder("reminder-dddddddddddddd", WATCH, "someone-else-entirely")).status).toBe(403)
  expect((await send("DELETE", `/api/reminders/${ID}?device=${DEVICE}`, undefined, "someone-else-entirely")).status).toBe(403)
  expect((await send("DELETE", `/api/reminders/${ID}?device=${DEVICE}`)).status).toBe(401)
  for (let i = 1; i < MAX_REMINDERS; i++)
    expect((await setReminder(`reminder-${String(i).padStart(14, "0")}`)).status).toBe(204)
  expect((await setReminder("reminder-eeeeeeeeeeeeee")).status).toBe(429)
  expect((await send("DELETE", `/api/reminders/${ID}?device=${DEVICE}`, undefined, SECRET)).status).toBe(204)
  expect(device().state.rows("reminders")).toHaveLength(MAX_REMINDERS - 1)
  expect((await send("DELETE", `/api/push/devices/${DEVICE}`, undefined, SECRET)).status).toBe(204)
  expect(device().state.rows("device")).toEqual([])
  expect(device().state.alarm()).toBeNull()
  env = { ...env, VAPID_PRIVATE_KEY: undefined }
  expect((await send("GET", "/api/push/key")).status).toBe(404)
  expect((await setReminder(ID)).status).toBe(404)
})

test("only a push service's address is taken, and a watch must be a run still to come at a stop, and a lead", async () => {
  const bad = async (subscription: object, watch: object = WATCH) =>
    (await send("PUT", `/api/reminders/${ID}`, { device: DEVICE, subscription, watch }, SECRET)).status
  for (const endpoint of ["http://fcm.googleapis.com/x", "https://example.com/push", "https://fcm.googleapis.com.example.com/x", "https://169.254.169.254/"])
    expect(await bad({ endpoint, keys: phone.keys })).toBe(400)
  const apple = { endpoint: "https://web.push.apple.com/abc", keys: phone.keys }
  expect(await bad({ ...apple, keys: { p256dh: "not base64!", auth: "x" } })).toBe(400)
  expect(await bad(apple, { ...WATCH, lead: 30 })).toBe(400)
  expect(await bad(apple, { stop: "209", route: "3", lead: 600 })).toBe(400)
  expect(await bad(apple, { ...WATCH, scheduled: NOW / 1000 - GONE - 1 })).toBe(400)
  expect(await bad(apple, { ...WATCH, scheduled: NOW / 1000 + FURTHEST + 60 })).toBe(400)
  expect(await bad(apple, { ...WATCH, scheduled: WATCH.scheduled + 0.5 })).toBe(400)
  expect(await bad({ ...apple, endpoint: `https://web.push.apple.com/${"a".repeat(2000)}` })).toBe(400)
  expect((await send("PUT", `/api/reminders/${ID}`, { device: DEVICE, subscription: apple, watch: WATCH })).status).toBe(401)
  expect(await bad(apple)).toBe(204)
})
