/// <reference types="node" />
// The social routes (worker/social.mts): each command as a device by its secret, what anyone reads back, and the
// rules: idempotent pins, marks idempotent per device, nobody going before the host sets a time, only the host sets
// it and deletes, setting asks those who marked that time and nobody else, spots fill, two reports hide, linking
// moves a device and its pins, codes verify a UNH address, and public pins take one

import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { app } from "../../worker/api.mts"
import type { Env } from "../../worker/env.mts"
import { HIDE, MAX_PINS_A_DAY, describePin, withPin } from "../../worker/social.mts"
import type { Message } from "../../worker/mail.mts"
import type { Pin, Time } from "../../src/social/event.mts"
import { type Ask, askOf } from "../../src/social/ask.mts"
import { parseCode, shown } from "../../src/social/link.mts"
import { d1 } from "./d1.mts"
import { type Key, MAX_BYTES, SYNCED, isNewer } from "../../src/shared/sync.mts"
import { browser, vapidKeys } from "./webpush.mts"

const PAGE = `<html><head><title>A pin · notunh</title><meta property="og:title" content="A pin"><meta property="og:description" content="Somewhere, sometime"><meta property="og:url" content="https://notunh.app/p/"><meta name="twitter:title" content="A pin"></head><body></body></html>`

/** A Worker with a fresh database, the pin page as its asset, and a mailer that keeps what it's sent */
const worker = (vars: Partial<Env> = {}) => {
  const sent: Message[] = []
  const env = {
    DB: d1(),
    ASSETS: { fetch: async (input: RequestInfo | URL) => new URL(input instanceof Request ? input.url : input).pathname === "/p/" ? new Response(PAGE, { headers: { "content-type": "text/html" } }) : new Response("", { status: 404 }) },
    EMAIL: { send: async ({ to, subject, text }: Message) => (sent.push({ to, subject, text }), { messageId: `test-${sent.length}` }) },
    ...vars
  } as unknown as Env
  /** A device: an id and a secret, asking the Worker as itself */
  const device = (name: string) => {
    const id = name.padEnd(16, "_")
    const secret = `secret-of-${id}`
    const ask = async (method: string, path: string, body?: unknown) => {
      const url = method === "GET" || method === "DELETE" && !body ? `http://notunh.app${path}${path.includes("?") ? "&" : "?"}device=${id}` : `http://notunh.app${path}`
      return app.fetch(new Request(url, {
        method,
        headers: { authorization: `Bearer ${secret}`, ...body ? { "content-type": "application/json" } : {} },
        body: body ? JSON.stringify({ device: id, ...body }) : undefined
      }), env)
    }
    return { id, secret, ask }
  }
  const anyone = (path: string) => app.fetch(new Request(`http://notunh.app${path}`), env)
  return { env, sent, device, anyone }
}

type Device = ReturnType<ReturnType<typeof worker>["device"]>

const soon = () => Date.now() + 3_600_000

/** Times an hour long, an hour apart from an hour from now */
const timesOf = (count: number): Time[] =>
  Array.from({ length: count }, (_, i) => ({ start: soon() + 2 * i * 3_600_000, end: soon() + (2 * i + 1) * 3_600_000 }))

const newPin = (overrides: Record<string, unknown> = {}) => ({
  id: `pin-${Math.random().toString(36).slice(2).padEnd(16, "0")}`,
  title: "Tennis", description: "Bring a racket", place: "Field House", where: "the courts",
  times: timesOf(1), visibility: "link",
  ...overrides
})

const made = async (device: Device, overrides: Record<string, unknown> = {}) => {
  const response = await device.ask("POST", "/api/pins", newPin(overrides))
  expect(response.status, await response.clone().text()).toBe(201)
  return await response.json() as Pin
}

test("a pin is made once under its id, read by anyone without who made it, and read as the maker's by its maker", async () => {
  const { device, anyone } = worker()
  const ana = device("ana")
  const body = newPin()
  const pin = await made(ana, body)
  expect(pin).toMatchObject({ id: body.id, title: "Tennis", place: "Field House", source: "pin", url: `https://notunh.app/p/${body.id}`, going: 0, yours: true, isGoing: false })
  // Again, as a retry, is the same pin, not another
  expect((await ana.ask("POST", "/api/pins", body)).status).toBe(201)
  const read = await (await anyone(`/api/pins/${body.id}`)).json() as Pin
  expect(read).not.toHaveProperty("yours")
  expect(JSON.stringify(read)).not.toContain("ana")
  // Another device can't take the id
  expect((await device("bo").ask("POST", "/api/pins", body)).status).toBe(409)
})

test("a secret set by a device's first command is the one every later command needs", async () => {
  const { env, device } = worker()
  const ana = device("ana")
  await made(ana)
  const forged = await app.fetch(new Request("http://notunh.app/api/pins", { method: "POST", headers: { authorization: "Bearer not-the-secret-at-all", "content-type": "application/json" }, body: JSON.stringify({ device: ana.id, ...newPin() }) }), env)
  expect(forged.status).toBe(401)
  expect((await app.fetch(new Request("http://notunh.app/api/pins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: ana.id, ...newPin() }) }), env)).status).toBe(401)
})

test("what's checked: text lengths, the window, a place, one to three times, spots, and the daily count", async () => {
  const { device } = worker()
  const ana = device("ana")
  const refused = async (overrides: Record<string, unknown>, status: number) =>
    expect((await ana.ask("POST", "/api/pins", newPin(overrides))).status, JSON.stringify(overrides)).toBe(status)
  await refused({ title: "" }, 400)
  await refused({ title: "x".repeat(81) }, 400)
  await refused({ description: "x".repeat(501) }, 400)
  await refused({ times: [{ start: soon(), end: soon() - 1 }] }, 400)
  await refused({ times: [{ start: Date.now() - 2 * 86_400_000, end: Date.now() }] }, 400)
  await refused({ times: [] }, 400)
  await refused({ times: timesOf(4) }, 400)
  await refused({ place: undefined }, 400)
  await refused({ spots: 0 }, 400)
  await refused({ spots: 1.5 }, 400)
  await refused({ visibility: "public" }, 403)
  await refused({ times: timesOf(3), spots: 4 }, 201)
  for (let i = 1; i < MAX_PINS_A_DAY; i++)
    await made(ana)
  await refused({}, 429)
})

test("going is a count anyone sees and a toggle each device has, and the host alone deletes", async () => {
  const { device, anyone } = worker()
  const [ana, bo, cy] = [device("ana"), device("bo"), device("cy")]
  const pin = await made(ana)
  const go = async (who: Device, going: boolean) => (await (await who.ask("POST", `/api/pins/${pin.id}/going`, { going })).json()) as Pin
  expect(await go(bo, true)).toMatchObject({ going: 1, isGoing: true, yours: false })
  expect(await go(bo, true)).toMatchObject({ going: 1 })
  expect(await go(cy, true)).toMatchObject({ going: 2, isGoing: true })
  expect(await go(bo, false)).toMatchObject({ going: 1, isGoing: false })
  expect((await (await anyone(`/api/pins/${pin.id}`)).json() as Pin).going).toBe(1)
  expect((await bo.ask("DELETE", `/api/pins/${pin.id}`, {})).status).toBe(403)
  expect((await ana.ask("DELETE", `/api/pins/${pin.id}`, {})).status).toBe(204)
  expect((await anyone(`/api/pins/${pin.id}`)).status).toBe(404)
  expect((await cy.ask("POST", `/api/pins/${pin.id}/going`, { going: true })).status).toBe(404)
})

test("spots fill: Going reads as taken of the spots, the one after the last is refused as Full, and leaving frees one", async () => {
  const { device } = worker()
  const [ana, bo, cy] = [device("ana"), device("bo"), device("cy")]
  const pin = await made(ana, { spots: 2 })
  const go = (who: Device, going: boolean) => who.ask("POST", `/api/pins/${pin.id}/going`, { going })
  expect(await (await go(ana, true)).json()).toMatchObject({ going: 1, spots: 2 })
  expect(await (await go(bo, true)).json()).toMatchObject({ going: 2, isGoing: true })
  const full = await go(cy, true)
  expect(full.status).toBe(409)
  expect(await full.text()).toBe("Full")
  // Going again while going isn't another spot
  expect(await (await go(bo, true)).json()).toMatchObject({ going: 2 })
  await go(ana, false)
  expect(await (await go(cy, true)).json()).toMatchObject({ going: 2, isGoing: true })
})

/** An event of a few times to pick, made by its host, and a few others */
const picking = async (count: number, others: number, vars: Partial<Env> = {}) => {
  const made_ = worker(vars)
  const host = made_.device("host")
  const people = Array.from({ length: others }, (_, i) => made_.device(`person${i}`))
  const times = timesOf(count)
  const pin = await made(host, { times: [...times].reverse() })
  return { ...made_, host, people, pin, times }
}

const mark = async (who: Device, pin: Pin, time: number, marked: boolean, subscription?: unknown) =>
  who.ask("POST", `/api/pins/${pin.id}/marks`, { time, marked, ...subscription ? { subscription } : {} })

const setTime = (who: Device, pin: Pin, time: number) =>
  who.ask("POST", `/api/pins/${pin.id}/set`, { time })

test("an event of times to pick keeps them earliest first, spans them, takes marks until the host sets one, which makes it ordinary", async () => {
  const { host, people: [bo], pin, times } = await picking(3, 1)
  expect(pin).toMatchObject({ times, marks: [0, 0, 0], start: times[0].start, end: times[2].end, going: 0, marked: [] })
  expect(pin).not.toHaveProperty("chosen")
  expect(await (await mark(bo, pin, 2, true)).json()).toMatchObject({ marks: [0, 0, 1], marked: [2] })
  expect((await mark(bo, pin, 3, true)).status).toBe(400)
  const set = await (await setTime(host, pin, 2)).json() as Pin
  expect(set).toMatchObject({ chosen: 2, start: times[2].start, end: times[2].end, marks: [0, 0, 1], going: 0 })
  expect((await mark(bo, pin, 1, true)).status).toBe(409)
  expect((await setTime(host, pin, 1)).status).toBe(409)
  expect(await (await bo.ask("POST", `/api/pins/${pin.id}/going`, { going: true })).json()).toMatchObject({ going: 1, isGoing: true })
})

/** What a device does to an event while its time is to pick: marks or unmarks a time, or tries to go */
const Step = fc.record({ who: fc.nat(3), kind: fc.constantFrom("mark", "unmark", "go"), time: fc.nat(2) })

test("marks are idempotent per device: each time's count is the devices whose last word on it was a mark", () =>
  fc.assert(fc.asyncProperty(fc.array(Step, { maxLength: 25 }), async steps => {
    const { people, pin } = await picking(3, 4)
    const last = new Map<string, boolean>()
    let read = pin
    for (const { who, kind, time } of steps.filter(step => step.kind !== "go")) {
      read = await (await mark(people[who], pin, time, kind === "mark")).json() as Pin
      last.set(`${who} ${time}`, kind === "mark")
      expect(read.marked).toEqual([0, 1, 2].filter(t => last.get(`${who} ${t}`)))
    }
    expect(read.marks).toEqual([0, 1, 2].map(time => [0, 1, 2, 3].filter(who => last.get(`${who} ${time}`)).length))
  }), { numRuns: 30 })
)

test("nobody is going before the host sets a time, whatever anyone taps, and Set enrolls nobody", () =>
  fc.assert(fc.asyncProperty(fc.array(Step, { maxLength: 15 }), fc.nat(2), async (steps, chosen) => {
    const { host, people, pin, anyone } = await picking(3, 4)
    for (const { who, kind, time } of steps) {
      const answer = kind === "go" ? await people[who].ask("POST", `/api/pins/${pin.id}/going`, { going: true }) : await mark(people[who], pin, time, kind === "mark")
      expect(answer.status).toBe(kind === "go" ? 409 : 200)
    }
    expect((await host.ask("POST", `/api/pins/${pin.id}/going`, { going: true })).status).toBe(409)
    expect((await (await anyone(`/api/pins/${pin.id}`)).json() as Pin).going).toBe(0)
    expect(await (await setTime(host, pin, chosen)).json()).toMatchObject({ chosen, going: 0 })
    for (const person of people)
      expect(await (await person.ask("GET", `/api/pins/${pin.id}`)).json()).toMatchObject({ isGoing: false })
  }), { numRuns: 30 })
)

test("only the host sets the time, once, from any of the host's devices", () =>
  fc.assert(fc.asyncProperty(fc.array(fc.nat(3), { maxLength: 6 }), fc.nat(2), async (tries, chosen) => {
    const { host, people, pin } = await picking(3, 4)
    for (const who of tries)
      expect((await setTime(people[who], pin, chosen)).status).toBe(403)
    expect(await (await setTime(host, pin, chosen)).json()).toMatchObject({ chosen, yours: true })
    expect((await setTime(host, pin, (chosen + 1) % 3)).status).toBe(409)
  }), { numRuns: 20 })
)

afterEach(() => {
  vi.unstubAllGlobals()
})

const [vapid, phone] = await Promise.all([vapidKeys(), browser()])

/** A device's push subscription, at an address of its own */
const subscriptionOf = (who: Device) =>
  ({ endpoint: `https://fcm.googleapis.com/fcm/send/${who.id}`, keys: phone.keys })

/** Every push sent, by the address it went to, read as the phone reads it */
const pushes = () => {
  const sent: { to: string, body: Promise<string> }[] = []
  vi.stubGlobal("fetch", async (request: Request) => {
    sent.push({ to: new URL(request.url).pathname.split("/").at(-1)!, body: request.arrayBuffer().then(body => phone.decrypt(new Uint8Array(body))) })
    return new Response(null, { status: 201 })
  })
  return sent
}

test("setting a time asks whoever marked it, with a subscription, \"Going?\", and nobody else anything", () =>
  fc.assert(fc.asyncProperty(fc.array(fc.subarray([0, 1, 2]), { minLength: 4, maxLength: 4 }), fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }), fc.nat(2), async (marked, subscribed, chosen) => {
    const sent = pushes()
    const { host, people, pin } = await picking(3, 4, { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey } as Partial<Env>)
    for (const [who, times] of marked.entries())
      for (const time of times)
        expect((await mark(people[who], pin, time, true, subscribed[who] ? subscriptionOf(people[who]) : undefined)).status).toBe(200)
    // The host marking nothing, and nobody pushed before the time is set
    expect(sent).toHaveLength(0)
    const set = await (await setTime(host, pin, chosen)).json() as Pin
    const asked = people.filter((_, who) => marked[who].includes(chosen) && subscribed[who]).map(who => who.id)
    expect(sent.map(({ to }) => to).sort()).toEqual(asked.sort())
    for (const { body } of sent)
      expect(JSON.parse(await body) as Ask).toEqual(askOf(set))
  }), { numRuns: 25 })
)

test("a subscription its push service says is gone isn't pushed to again", async () => {
  const vars = { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey } as Partial<Env>
  const { env, host, people: [bo], pin } = await picking(2, 1, vars)
  let tries = 0
  vi.stubGlobal("fetch", async () => (tries++, new Response(null, { status: 410 })))
  await mark(bo, pin, 0, true, subscriptionOf(bo))
  await setTime(host, pin, 0)
  expect(tries).toBe(1)
  const { push } = (env.DB as unknown as ReturnType<typeof d1>).sqlite.prepare("select push from devices where id = ?").get(bo.id) as { push: string | null }
  expect(push).toBeNull()
})

test("reports from two devices hide a pin from everyone, from one device twice don't", async () => {
  const { device, anyone } = worker()
  const [ana, bo, cy] = [device("ana"), device("bo"), device("cy")]
  const pin = await made(ana)
  const report = async (who: Device) => (await (await who.ask("POST", `/api/pins/${pin.id}/reports`, {})).json()) as { hidden: boolean }
  expect(await report(bo)).toEqual({ hidden: false })
  expect(await report(bo)).toEqual({ hidden: false })
  expect((await anyone(`/api/pins/${pin.id}`)).status).toBe(200)
  expect(await report(cy)).toEqual({ hidden: HIDE <= 2 })
  expect((await anyone(`/api/pins/${pin.id}`)).status).toBe(404)
  expect((await anyone(`/p/${pin.id}`)).status).toBe(404)
})

test("a code links the device that shows it to the person of the device that approves it, pins and all, within its time", async () => {
  const { device, anyone } = worker()
  const [phone, laptop, other] = [device("phone"), device("laptop"), device("other")]
  const pin = await made(laptop, { times: timesOf(2) })
  const { code, expires } = await (await laptop.ask("POST", "/api/link", {})).json() as { code: string, expires: number }
  expect(parseCode(code)).toBe(code)
  expect(expires).toBeGreaterThan(Date.now())
  expect(await (await laptop.ask("GET", `/api/link/${code}`)).json()).toMatchObject({ linked: false })
  // Only the device that made the code may ask after it
  expect((await phone.ask("GET", `/api/link/${code}`)).status).toBe(404)
  expect((await anyone(`/api/link/${code}`)).status).toBe(401)
  // Approving your own code links nothing
  expect((await laptop.ask("POST", `/api/link/${shown(code)}`, {})).status).toBe(409)
  expect((await phone.ask("POST", `/api/link/${code.toLowerCase()}`, {})).status).toBe(200)
  expect(await (await laptop.ask("GET", `/api/link/${code}`)).json()).toMatchObject({ linked: true })
  // One person now: the laptop's pin is the phone's to set and delete, and the code is spent
  expect((await phone.ask("POST", `/api/pins/${pin.id}/set`, { time: 1 })).status).toBe(200)
  const me = await Promise.all([phone, laptop].map(async who => (await (await who.ask("GET", "/api/me")).json() as { person: string }).person))
  expect(me[0]).toBe(me[1])
  expect((await other.ask("POST", `/api/link/${code}`, {})).status).toBe(404)
  expect((await other.ask("POST", "/api/link/NOPE-CODE", {})).status).toBe(400)
})

test("a six-digit code sent to a UNH address verifies the person who typed it back, with five guesses, and lets them list pins", async () => {
  const { device, sent, anyone } = worker()
  const ana = device("ana")
  expect((await ana.ask("POST", "/api/email", { address: "ana@gmail.com" })).status).toBe(400)
  expect((await ana.ask("POST", "/api/email", { address: " Ana.B@Wildcats.UNH.edu " })).status).toBe(200)
  expect(sent).toHaveLength(1)
  expect(sent[0].to).toBe("ana.b@wildcats.unh.edu")
  const code = sent[0].subject.match(/^(\d{6}) /)![1]
  expect(sent[0].text).toContain(`#verify=${encodeURIComponent("ana.b@wildcats.unh.edu")}:${code}`)
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0")
  for (let i = 0; i < 4; i++)
    expect((await ana.ask("POST", "/api/email/verify", { address: "ana.b@wildcats.unh.edu", code: wrong })).status).toBe(403)
  // Another device can't use ana's attempt
  expect((await device("bo").ask("POST", "/api/email/verify", { address: "ana.b@wildcats.unh.edu", code })).status).toBe(404)
  expect(await (await ana.ask("POST", "/api/email/verify", { address: "ana.b@wildcats.unh.edu", code })).json()).toEqual({ verified: "ana.b@wildcats.unh.edu", joined: false })
  expect(await (await ana.ask("GET", "/api/me")).json()).toMatchObject({ verified: "ana.b@wildcats.unh.edu" })
  const pin = await made(ana, { visibility: "public" })
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(pin.start)
  const listed = await (await anyone(`/api/pins?day=${day}`)).json() as Pin[]
  expect(listed.map(({ id }) => id)).toEqual([pin.id])
  expect(listed[0]).not.toHaveProperty("yours")
  // A sixth guess is one too many, so a fresh code is needed
  await ana.ask("POST", "/api/email", { address: "ana.b@wildcats.unh.edu" })
  for (let i = 0; i < 5; i++)
    await ana.ask("POST", "/api/email/verify", { address: "ana.b@wildcats.unh.edu", code: wrong })
  const [, last] = sent
  expect((await ana.ask("POST", "/api/email/verify", { address: "ana.b@wildcats.unh.edu", code: last.subject.slice(0, 6) })).status).toBe(404)
})

test("a pin's page carries its title and a line about it for link previews, escaped", async () => {
  const { device, anyone } = worker()
  const pin = await made(device("ana"), { title: "Tea & <cake>", place: "Memorial Union Building" })
  const page = await anyone(`/p/${pin.id}`)
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).toContain("<title>Tea &amp; &lt;cake&gt; · notunh</title>")
  expect(html).toContain(`<meta property="og:url" content="https://notunh.app/p/${pin.id}">`)
  expect(html).toContain(`<meta property="og:description" content="${describePin(pin)}">`)
  expect(describePin(pin)).toMatch(/^\w{3} \d{1,2}:\d\d [AP]M · Memorial Union Building$/)
  expect((await anyone("/p/nope")).status).toBe(404)
})

test("whatever a pin says, its page's head stays well-formed, a title of dollar signs included", () =>
  fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 80 }), fc.constant("$& $1 $' $$")), fc.string({ maxLength: 80 }), fc.nat(50), (title, place, going) => {
    const pin: Pin = { id: "a".repeat(16), title, start: 0, end: 1, place, where: place, source: "pin", url: "https://notunh.app/p/" + "a".repeat(16), description: "", visibility: "link", times: [], marks: [], going }
    const html = withPin(PAGE, pin)
    const metas = [...html.matchAll(/<meta (?:name|property)="[^"]+" content="([^"]*)">/g)]
    expect(metas).toHaveLength(4)
    for (const [, content] of metas)
      expect(content).not.toMatch(/[<>"]/)
    expect(html.match(/<title>([^<]*)<\/title>/)![1]).not.toMatch(/[<>]/)
    expect(html).toContain(`<title>${title.replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]!)} · notunh</title>`)
  }))
)

test("each kill switch answers 503 for its feature and nothing else", async () => {
  const { device } = worker({ SOCIAL_OFF: "pins link" })
  const ana = device("ana")
  expect((await ana.ask("POST", "/api/pins", newPin())).status).toBe(503)
  expect((await ana.ask("POST", "/api/link", {})).status).toBe(503)
  expect((await ana.ask("POST", "/api/email", { address: "ana@unh.edu" })).status).toBe(200)
})

//#region Your things, kept for you

type Kept = { entries: Record<string, { value: unknown, at: number, by: string }> }

/** A write to a key, by a browser, at a time */
const write = fc.record({ key: fc.constantFrom(...SYNCED), value: fc.integer(), at: fc.integer({ min: 1, max: 1000 }), by: fc.constantFrom("a", "b", "c") })
  .map(({ value, ...stamp }) => ({ ...stamp, value: { [stamp.by]: stamp.at, value } }))

/** The newest of some writes to each key, by isNewer, as every device and the Worker order them */
const newest = (writes: readonly { key: Key, value: unknown, at: number, by: string }[]) => {
  const out: Record<string, { value: unknown, at: number, by: string }> = {}
  for (const { key, ...entry } of writes)
    if (isNewer(entry, out[key]))
      out[key] = entry
  return out
}

test("the Worker keeps each key's newest write, whichever of a person's devices sent it and in whatever order and batches", async () =>
  fc.assert(fc.asyncProperty(fc.array(write, { maxLength: 24 }), fc.array(fc.nat(2), { maxLength: 24 }), fc.array(fc.nat(3), { minLength: 1, maxLength: 6 }), async (writes, senders, cuts) => {
    const { device } = worker()
    const devices = [device("phone"), device("laptop"), device("tablet")]
    // One person: the phone approves the others' codes
    for (const other of devices.slice(1)) {
      const { code } = await (await other.ask("POST", "/api/link", {})).json() as { code: string }
      expect((await devices[0].ask("POST", `/api/link/${code}`, {})).status).toBe(200)
    }
    let at = 0
    for (let i = 0; at < writes.length; i++) {
      const batch = writes.slice(at, at += 1 + cuts[i % cuts.length])
      const entries = Object.fromEntries(batch.map(({ key, ...entry }) => [key, entry]))
      const answer = await devices[senders[i % Math.max(1, senders.length)] ?? 0].ask("POST", "/api/state", { entries })
      expect(answer.status).toBe(200)
    }
    // A batch names a key once, so a key written twice in one is its last there, as a device sends it
    const sent: typeof writes = []
    at = 0
    for (let i = 0; at < writes.length; i++)
      sent.push(...Object.values(Object.fromEntries(writes.slice(at, at += 1 + cuts[i % cuts.length]).map(found => [found.key, found]))))
    for (const asking of devices)
      expect((await (await asking.ask("POST", "/api/state", { entries: {} })).json() as Kept).entries).toEqual(newest(sent))
  })), 60_000)

test("a write is never kept as later than the Worker's clock, only keys kept for you are taken, and values are bounded", async () => {
  const { device } = worker()
  const ana = device("ana")
  const ahead = Date.now() + 86_400_000
  const { entries } = await (await ana.ask("POST", "/api/state", { entries: { "parking-permit": { value: "commuter", at: ahead, by: "a" } } })).json() as Kept
  expect(entries["parking-permit"].at).toBeLessThanOrEqual(Date.now())
  expect(entries["parking-permit"].value).toBe("commuter")
  expect((await ana.ask("POST", "/api/state", { entries: { "map-trip": { value: 1, at: 1, by: "a" } } })).status).toBe(400)
  expect((await ana.ask("POST", "/api/state", { entries: { "map-goals": { value: "x".repeat(MAX_BYTES), at: 1, by: "a" } } })).status).toBe(400)
  expect((await ana.ask("POST", "/api/state", { entries: { "map-goals": { at: 1, by: "a" } } })).status).toBe(400)
  // Another person's things are theirs alone
  expect((await (await device("bo").ask("POST", "/api/state", { entries: {} })).json() as Kept).entries).toEqual({})
})

/** A request bearing only the cookie a response set, as a browser whose own storage was cleared sends */
const withCookie = (env: Env, setCookie: string | null, path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`https://notunh.app${path}`, { ...init, headers: { ...init.headers, ...setCookie && { cookie: setCookie.split(";")[0] } } }), env)

test("a command sets the device's cookie, which alone gets its id and secret back and asks as it, and no other device's", async () => {
  const { env, device } = worker()
  const ana = device("ana")
  const answer = await ana.ask("POST", "/api/state", { entries: { "courses-saved": { value: ["202610:12496"], at: 5, by: "a" } } })
  const setCookie = answer.headers.get("set-cookie")
  expect(setCookie).toContain("HttpOnly")
  // Storage cleared: the cookie alone is the device again
  const session = await withCookie(env, setCookie, "/api/session")
  expect(session.status).toBe(200)
  expect(await session.json()).toEqual({ device: ana.id, secret: ana.secret })
  expect(session.headers.get("set-cookie")).toContain("Secure")
  const kept = await withCookie(env, setCookie, "/api/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: ana.id, entries: {} }) })
  expect((await kept.json() as Kept).entries["courses-saved"].value).toEqual(["202610:12496"])
  // Not for another device it names, nor with no cookie, nor a secret that isn't the one set
  expect((await withCookie(env, setCookie, "/api/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: device("bo").id, entries: {} }) })).status).toBe(401)
  expect((await withCookie(env, null, "/api/session")).status).toBe(401)
  expect((await withCookie(env, `notunh-device=${ana.id}.${"x".repeat(32)}`, "/api/session")).status).toBe(401)
})

test("linking keeps each key's newer write of the two people's, and a UNH address verified before gets a wiped device back", async () => {
  const { device, sent } = worker()
  const [phone, laptop] = [device("phone"), device("laptop")]
  await phone.ask("POST", "/api/state", { entries: { "parking-permit": { value: "commuter", at: 10, by: "p" }, "dining-hall": { value: "philbrook", at: 30, by: "p" } } })
  await laptop.ask("POST", "/api/state", { entries: { "parking-permit": { value: "resident", at: 20, by: "l" }, "dining-hall": { value: "holloway", at: 5, by: "l" }, "map-goals": { value: [], at: 1, by: "l" } } })
  const { code } = await (await laptop.ask("POST", "/api/link", {})).json() as { code: string }
  await phone.ask("POST", `/api/link/${code}`, {})
  const linked = (await (await laptop.ask("POST", "/api/state", { entries: {} })).json() as Kept).entries
  expect(Object.fromEntries(Object.entries(linked).map(([key, { value }]) => [key, value]))).toEqual({ "parking-permit": "resident", "dining-hall": "philbrook", "map-goals": [] })

  // The phone verifies its address; then its storage and cookie are gone, and it's a new device
  await phone.ask("POST", "/api/email", { address: "pat@unh.edu" })
  await phone.ask("POST", "/api/email/verify", { address: "pat@unh.edu", code: sent.at(-1)!.subject.slice(0, 6) })
  const fresh = device("fresh-phone")
  expect((await (await fresh.ask("POST", "/api/state", { entries: {} })).json() as Kept).entries).toEqual({})
  await fresh.ask("POST", "/api/email", { address: "pat@unh.edu" })
  const recovered = await fresh.ask("POST", "/api/email/verify", { address: "pat@unh.edu", code: sent.at(-1)!.subject.slice(0, 6) })
  expect(await recovered.json()).toEqual({ verified: "pat@unh.edu", joined: true })
  expect((await (await fresh.ask("POST", "/api/state", { entries: {} })).json() as Kept).entries).toEqual(linked)
  const people = await Promise.all([phone, laptop, fresh].map(async who => (await (await who.ask("GET", "/api/me")).json() as { person: string }).person))
  expect(new Set(people).size).toBe(1)
})

test("the code's message is plain and short: the code, how long it lasts, the link to confirm, and what to do if it wasn't you", async () => {
  const { device, sent } = worker()
  await device("ana").ask("POST", "/api/email", { address: "ana@unh.edu" })
  const [{ to, subject, text }] = sent
  const code = subject.slice(0, 6)
  expect(to).toBe("ana@unh.edu")
  expect(subject).toBe(`${code} is your notunh code`)
  expect(text.split("\n")[0]).toBe(code)
  expect(text).toContain("10 minutes")
  expect(text).toContain(`https://notunh.app/map/#verify=ana%40unh.edu:${code}`)
  expect(text.length).toBeLessThan(300)
})

test("a code the email service refuses to send says so, and the binding is given the sender", async () => {
  const given: unknown[] = []
  const { device } = worker({ MAIL_FROM: "codes@notunh.app", EMAIL: { send: async (message: unknown) => { given.push(message); throw Object.assign(new Error("suppressed"), { code: "E_RECIPIENT_SUPPRESSED" }) } } as unknown as SendEmail })
  vi.spyOn(console, "error").mockImplementation(() => {})
  expect((await device("ana").ask("POST", "/api/email", { address: "ana@unh.edu" })).status).toBe(502)
  expect(given[0]).toMatchObject({ from: { email: "codes@notunh.app", name: "notunh" }, to: "ana@unh.edu" })
})

//#endregion
