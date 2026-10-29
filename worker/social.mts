// Pins, marks, going, reports, device links, UNH email verification, and your things kept for you (docs/social.md):
// the social routes, every write a command checked here and run against D1 as the device by its secret, borne as a
// bearer token or, where the device's own storage has lost it, by the cookie the Worker keeps it in (session.mts). A
// device's first command sets its secret, as the reminders object does, and makes it a person of its own; linking,
// or verifying a UNH address another device of yours verified, moves it to that person. Reads are public, and answer
// what the asking device has to do with a pin when it asks as itself. Every pin is read back as one Pin
// (src/social/event.mts); one whose time is to pick takes marks until its host sets a time, which asks those who
// marked it "Going?" (src/social/marks.mts, src/social/ask.mts)

import { Hono } from "hono/tiny"
import type { MiddlewareHandler } from "hono"
import { sValidator } from "@hono/standard-validator"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { type SQL, and, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import * as v from "valibot"
import { type Pin, LINGER, LONG, MAX_SPOTS, MAX_TIMES, SHORT, isOn, pinPath } from "../src/social/event.mts"
import { isUnset, sortedTimes, spanOf } from "../src/social/marks.mts"
import { askOf } from "../src/social/ask.mts"
import { LINK_TTL, codeOf, parseCode } from "../src/social/link.mts"
import { SITE } from "../src/shell/pages.mts"
import { describeIssues } from "../src/shared/json.mts"
import { DAY, Day, dayStart } from "../src/shared/time.mts"
import type { Env } from "./env.mts"
import { send } from "./mail.mts"
import { Subscription, push } from "./push.mts"
import { vapidOf } from "./reminders.mts"
import { devices, emails, going, links, marks, pins, reports, state } from "./schema.mts"
import { type Credential, cookieOf, credentialFrom } from "./session.mts"
import { Entries, isSynced } from "../src/shared/sync.mts"

type Worker = { Bindings: Env, Variables: { who: Who, credential: Credential } }

/** The device asking, and the person it belongs to */
type Who = { device: string, person: string }

/** Reports from distinct devices that hide a pin */
export const HIDE = 2
/** Pins a person may make in a day, and how far ahead and back a pin may be set */
export const MAX_PINS_A_DAY = 10
const FURTHEST = 120 * DAY
/** How long a verification code lasts, how many guesses it gets, and how long a verified address stays so */
const CODE_TTL = 10 * 60_000
const CODE_TRIES = 5
const VERIFIED_FOR = 365 * DAY
const UNH = /^[^\s@]+@(unh\.edu|wildcats\.unh\.edu)$/

/** The social features, each switched off by naming it in SOCIAL_OFF */
export type Feature = "pins" | "link" | "email" | "sync"

export const social = new Hono<Worker>()

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, "0")).join("")

const valid = <S extends StandardSchemaV1, T extends "json" | "query" | "param" = "json">(schema: S, target = "json" as T) =>
  sValidator(target, schema, (result, c) => result.success ? undefined : c.text(describeIssues(result.error), 400))

const ID = v.pipe(v.string(), v.regex(/^[\w-]{16,64}$/))
const Text = (max: number) => v.pipe(v.string(), v.trim(), v.maxLength(max))
const Instant = v.pipe(v.number(), v.integer())

/** A feature's switch: 503 while it's named in SOCIAL_OFF */
const on = (feature: Feature): MiddlewareHandler<Worker> => async (c, next) =>
  c.env.SOCIAL_OFF?.split(/[\s,]+/).includes(feature) ? c.text(`${{ pins: "Events are", link: "Linking devices is", email: "Email verification is", sync: "Keeping your things is" }[feature]} off for now`, 503) : next()

/** Only so many commands a minute from one address, by the Rate Limiting binding where it's bound */
const limited: MiddlewareHandler<Worker> = async (c, next) => {
  const address = c.req.header("cf-connecting-ip")
  if (c.env.RATE_LIMIT && address && !(await c.env.RATE_LIMIT.limit({ key: address })).success)
    return c.text("Too much from here at once; try again in a minute", 429)
  return next()
}

type Asking = { env: Env, req: { url: string, header(name: string): string | undefined, query(name: string): string | undefined } }

/**
 * The credential a request bears: the secret as a bearer token for the device it names, else the cookie's, for the
 * device it names if it names one. byCookie takes the cookie's alone
 */
const credentialOf = (c: Asking, named: string | undefined, byCookie = false): Credential | undefined => {
  const secret = c.req.header("authorization")?.match(/^Bearer (\S{16,200})$/)?.[1]
  if (secret && named && !byCookie)
    return { device: named, secret }
  const cookie = credentialFrom(c.req.header("cookie"))
  return cookie && (!named || cookie.device === named) ? cookie : undefined
}

/**
 * Who's asking, by a credential: a device's first ask sets its secret and makes it a person of its own; a secret
 * that isn't the one set is refused
 */
const asked = async (env: Env, credential: Credential | undefined): Promise<Who | undefined> => {
  if (!credential)
    return
  const { device, secret } = credential
  await drizzle(env.DB).insert(devices).values({ id: device, secret: await sha256(secret), person: device, created: Date.now() }).onConflictDoNothing()
  return whoIs(env, credential)
}

/** Who a credential is, if it's a device's whose secret is the one set, without making it one */
const whoIs = async (env: Env, { device, secret }: Credential): Promise<Who | undefined> => {
  const [row] = await drizzle(env.DB).select({ secret: devices.secret, person: devices.person }).from(devices).where(eq(devices.id, device))
  return row?.secret === await sha256(secret) ? { device, person: row.person } : undefined
}

const isSecure = (c: Asking) =>
  new URL(c.req.url).protocol === "https:"

/** Asked as the device the body names, else 401; the cookie that keeps its credential is set, or renewed, with the answer */
const asDevice: MiddlewareHandler<Worker> = async (c, next) => {
  const { device } = await c.req.json<{ device: string }>()
  const credential = credentialOf(c, device)
  const who = await asked(c.env, credential)
  if (!who)
    return c.text("Not this device's", 401)
  c.set("who", who)
  c.set("credential", credential!)
  await next()
  c.header("set-cookie", cookieOf(credential!, isSecure(c)))
}

/** Asked as the device the query names, if it is, which a read is answered more fully for */
const maybeDevice = async (c: Asking) => {
  const device = c.req.query("device")
  return device && v.is(ID, device) ? asked(c.env, credentialOf(c, device)) : undefined
}

//#region Pins

type Row = typeof pins.$inferSelect
type Db = ReturnType<typeof drizzle>

/** A verified UNH address of a person, if they hold one */
const verifiedOf = async (db: Db, person: string, now: number) =>
  (await db.select({ address: emails.address }).from(emails).where(and(eq(emails.person, person), gt(emails.verified, now - VERIFIED_FOR))))[0]?.address

/** How many marked each time of some pins, by pin */
const marksOf = async (db: Db, rows: readonly Row[]) => {
  const byPin = new Map<string, number[]>(rows.map(row => [row.id, row.times.map(() => 0)]))
  const picking = rows.filter(row => row.times.length).map(row => row.id)
  const counted = picking.length
    ? await db.select({ pin: marks.pin, time: marks.time, n: sql<number>`count(*)` }).from(marks).where(inArray(marks.pin, picking)).groupBy(marks.pin, marks.time)
    : []
  for (const { pin, time, n } of counted) {
    const counts = byPin.get(pin)
    if (counts && time in counts)
      counts[time] = n
  }
  return byPin
}

/** A pin as everyone reads it, and as the asking device has it */
const pinOf = (row: Row, counts: number[], going: number, mine?: { yours: boolean, isGoing: boolean, marked: number[] }): Pin => ({
  id:          row.id,
  title:       row.title,
  start:       row.start,
  end:         row.end,
  place:       row.place ?? undefined,
  where:       row.where,
  source:      "pin",
  url:         SITE + pinPath(row.id),
  description: row.description,
  visibility:  row.visibility,
  times:       row.times,
  marks:       counts,
  ...row.chosen !== null && { chosen: row.chosen },
  going,
  ...row.spots !== null && { spots: row.spots },
  ...mine
})

/** Pins' rows with how many are going, and no row for one hidden by reports; `where` picks them */
const rowsWhere = (db: Db, where: SQL) =>
  db.select({
    row:     pins,
    going:   sql<number>`(select count(*) from ${going} where ${going.pin} = ${pins.id})`,
    reports: sql<number>`(select count(*) from ${reports} where ${reports.pin} = ${pins.id})`
  }).from(pins).where(where)

/** A pin as read, with everything a Pin says, or none while there's no such pin to show */
const readPin = async (db: Db, id: string, who: Who | undefined): Promise<Pin | undefined> => {
  const [found] = await rowsWhere(db, eq(pins.id, id))
  if (!found || found.reports >= HIDE)
    return
  const [counts, mine] = await Promise.all([
    marksOf(db, [found.row]),
    who && Promise.all([
      db.select({ pin: going.pin }).from(going).where(and(eq(going.pin, id), eq(going.device, who.device))),
      db.select({ time: marks.time }).from(marks).where(and(eq(marks.pin, id), eq(marks.device, who.device)))
    ]).then(([isGoing, own]) => ({ yours: found.row.person === who.person, isGoing: isGoing.length > 0, marked: own.map(({ time }) => time).sort((a, b) => a - b) }))
  ])
  return pinOf(found.row, counts.get(id)!, found.going, mine)
}

const Candidate = v.pipe(v.object({ start: Instant, end: Instant }), v.check(time => time.end > time.start, "A time ends after it starts"))

/**
 * A pin as made, under an id the device made, so the same command again is the same pin: one time, which makes an
 * ordinary event, or up to three to pick from
 */
const NewPin = v.object({
  device:      ID,
  id:          ID,
  title:       v.pipe(Text(SHORT), v.minLength(1)),
  description: Text(LONG),
  place:       v.pipe(Text(SHORT), v.minLength(1)),
  where:       Text(SHORT),
  times:       v.pipe(v.array(Candidate), v.minLength(1, "A time"), v.maxLength(MAX_TIMES, `At most ${MAX_TIMES} times`)),
  spots:       v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_SPOTS))),
  visibility:  v.picklist(["link", "public"])
})

social.post("/api/pins", on("pins"), limited, valid(NewPin), asDevice, async c => {
  const { device: _, times: given, spots, ...made } = c.req.valid("json")
  const who = c.get("who")
  const db = drizzle(c.env.DB)
  const now = Date.now()
  const times = sortedTimes(given)
  if (times[0].start < now - DAY || times.at(-1)!.start > now + FURTHEST)
    return c.text("An event is for the coming weeks", 400)
  if (made.visibility === "public" && !await verifiedOf(db, who.person, now))
    return c.text("Listing an event takes a verified UNH address", 403)
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(pins).where(and(eq(pins.person, who.person), gt(pins.created, now - DAY)))
  if (n >= MAX_PINS_A_DAY)
    return c.text(`At most ${MAX_PINS_A_DAY} events a day`, 429)
  await db.insert(pins).values({
    ...made,
    ...spanOf(times),
    times:   times.length > 1 ? times : [],
    spots:   spots ?? null,
    person:  who.person,
    created: now
  }).onConflictDoNothing()
  const [row] = await db.select({ person: pins.person }).from(pins).where(eq(pins.id, made.id))
  if (row.person !== who.person)
    return c.text("That id is another's", 409)
  return c.json(await readPin(db, made.id, who), 201)
})

// The public pins on a Durham day, soonest first
social.get("/api/pins", on("pins"), valid(v.object({ day: Day }), "query"), async c => {
  const db = drizzle(c.env.DB)
  const { day } = c.req.valid("query")
  const now = Date.now()
  const found = (await rowsWhere(db, and(eq(pins.visibility, "public"), lt(pins.start, dayStart(day) + DAY), gt(pins.end, dayStart(day) - LINGER))!))
    .filter(({ reports }) => reports < HIDE)
  const counts = await marksOf(db, found.map(({ row }) => row))
  const listed = found.map(({ row, going }) => pinOf(row, counts.get(row.id)!, going)).filter(pin => isOn(pin, day, now)).sort((a, b) => a.start - b.start)
  return c.json(listed, 200, { "cache-control": "no-store" })
})

social.get("/api/pins/:id", on("pins"), valid(v.object({ id: ID }), "param"), async c => {
  const pin = await readPin(drizzle(c.env.DB), c.req.valid("param").id, await maybeDevice(c))
  return pin ? c.json(pin, 200, { "cache-control": "no-store" }) : c.notFound()
})

/** A command on one pin, as its host if `byHost`, else as anyone, given the pin's row */
const onPin = (byHost: boolean, run: (c: Parameters<MiddlewareHandler<Worker>>[0], row: Row, who: Who, db: Db) => Promise<Response>): MiddlewareHandler<Worker> => async c => {
  const db = drizzle(c.env.DB)
  const who = c.get("who")
  const [found] = await rowsWhere(db, eq(pins.id, c.req.param("id")!))
  if (!found || found.reports >= HIDE)
    return c.notFound()
  if (byHost && found.row.person !== who.person)
    return c.text("Not your event", 403)
  return run(c, found.row, who, db)
}

/** Whether a pin's time is still to pick, as its row has it */
const isUnsetRow = (row: Row) =>
  isUnset({ times: row.times, chosen: row.chosen ?? undefined })

const Device = v.object({ device: ID })
const PinId = valid(v.object({ id: ID }), "param")
const Index = v.pipe(v.number(), v.integer(), v.minValue(0))

// Going, or not, once there's a time, taking a spot where there are spots, if one's left
social.post("/api/pins/:id/going", on("pins"), limited, PinId, valid(v.object({ ...Device.entries, going: v.boolean() })), asDevice, onPin(false, async (c, row, who, db) => {
  if (isUnsetRow(row))
    return c.text("The time's still to pick", 409)
  const { going: wants } = await c.req.json<{ going: boolean }>()
  if (!wants)
    await db.delete(going).where(and(eq(going.pin, row.id), eq(going.device, who.device)))
  else
    await db.run(sql`insert into ${going} ("pin", "device") select ${row.id}, ${who.device} where ${row.spots === null ? sql`1` : sql`(select count(*) from ${going} where ${going.pin} = ${row.id}) < ${row.spots}`} on conflict do nothing`)
  const pin = (await readPin(db, row.id, who))!
  return wants && !pin.isGoing ? c.text("Full", 409) : c.json(pin)
}))

// A mark on a time, or none, which says the time works for this device; with a push subscription, so it's asked
// "Going?" if the host sets that time
social.post("/api/pins/:id/marks", on("pins"), limited, PinId, valid(v.object({ ...Device.entries, time: Index, marked: v.boolean(), subscription: v.optional(Subscription) })), asDevice, onPin(false, async (c, row, who, db) => {
  const { time, marked, subscription } = await c.req.json<{ time: number, marked: boolean, subscription?: Subscription }>()
  if (!isUnsetRow(row))
    return c.text("The time's set", 409)
  if (time >= row.times.length)
    return c.text("No such time", 400)
  await db.batch([
    marked
      ? db.insert(marks).values({ pin: row.id, device: who.device, time }).onConflictDoNothing()
      : db.delete(marks).where(and(eq(marks.pin, row.id), eq(marks.device, who.device), eq(marks.time, time))),
    ...subscription ? [db.update(devices).set({ push: subscription }).where(eq(devices.id, who.device))] : []
  ])
  return c.json(await readPin(db, row.id, who))
}))

/** Asks each device that marked a pin's time, now set, "Going?", where it gave a subscription, forgetting those gone */
const ask = async (env: Env, db: Db, pin: Pin) => {
  const vapid = vapidOf(env)
  if (!vapid || pin.chosen === undefined)
    return
  const asked = await db.select({ id: devices.id, push: devices.push }).from(marks).innerJoin(devices, eq(devices.id, marks.device))
    .where(and(eq(marks.pin, pin.id), eq(marks.time, pin.chosen), isNotNull(devices.push)))
  const message = JSON.stringify(askOf(pin))
  const now = Date.now()
  await Promise.all(asked.map(async ({ id, push: subscription }) => {
    const { sent } = await push(subscription!, message, vapid, { ttl: Math.max(60, (pin.start - now) / 1000), topic: pin.id.slice(0, 32) }, now / 1000)
    if (sent === "gone")
      await db.update(devices).set({ push: null }).where(eq(devices.id, id))
  }))
}

// The host sets one of the times, which makes it an ordinary event, and asks whoever marked it
social.post("/api/pins/:id/set", on("pins"), limited, PinId, valid(v.object({ ...Device.entries, time: Index })), asDevice, onPin(true, async (c, row, who, db) => {
  const { time } = await c.req.json<{ time: number }>()
  if (!isUnsetRow(row))
    return c.text("The time's set", 409)
  if (time >= row.times.length)
    return c.text("No such time", 400)
  await db.update(pins).set({ ...row.times[time], chosen: time }).where(eq(pins.id, row.id))
  const pin = (await readPin(db, row.id, who))!
  await ask(c.env, db, pin)
  return c.json(pin)
}))

/** Everything of a pin, dropped together */
const dropPins = (db: Db, where: SQL) => {
  const ids = db.select({ id: pins.id }).from(pins).where(where)
  return [
    db.delete(going).where(inArray(going.pin, ids)),
    db.delete(marks).where(inArray(marks.pin, ids)),
    db.delete(reports).where(inArray(reports.pin, ids)),
    db.delete(pins).where(where)
  ] as const
}

social.delete("/api/pins/:id", on("pins"), PinId, valid(Device), asDevice, onPin(true, async (c, row, _, db) => {
  await db.batch(dropPins(db, eq(pins.id, row.id)))
  return c.body(null, 204)
}))

social.post("/api/pins/:id/reports", on("pins"), limited, PinId, valid(Device), asDevice, onPin(false, async (c, row, who, db) => {
  await db.insert(reports).values({ pin: row.id, device: who.device }).onConflictDoNothing()
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(reports).where(eq(reports.pin, row.id))
  return c.json({ hidden: n >= HIDE })
}))

//#endregion

//#region Linking devices

/** Whether a row written to state is newer than the one there, as isNewer in src/shared/sync.mts decides */
const isNewerRow = sql`excluded."at" > ${state.at} or (excluded."at" = ${state.at} and excluded."by" > ${state.by})`

/** A row written to state in place of the one there, which isNewerRow allows */
const keptIfNewer = { value: sql`excluded."value"`, at: sql`excluded."at"`, by: sql`excluded."by"` }

/**
 * Everything of one person moved to another, as linking a device, or recovering one by its UNH address, does: its
 * devices, pins and addresses, and each of its things kept, where it's newer than the other's
 */
const join = (db: Db, was: string, into: string) => [
  db.update(devices).set({ person: into }).where(eq(devices.person, was)),
  db.update(pins).set({ person: into }).where(eq(pins.person, was)),
  db.update(emails).set({ person: into }).where(eq(emails.person, was)),
  db.update(emails).set({ pending: into }).where(eq(emails.pending, was)),
  db.insert(state)
    .select(db.select({ person: sql<string>`${into}`.as("person"), key: state.key, value: state.value, at: state.at, by: state.by }).from(state).where(eq(state.person, was)))
    .onConflictDoUpdate({ target: [state.person, state.key], set: keptIfNewer, setWhere: isNewerRow }),
  db.delete(state).where(eq(state.person, was))
] as const

// The new device asks for a code, which it shows; the device that has the identity approves it, which moves the new
// device, and everything of the person it was, to the approver's person
social.post("/api/link", on("link"), limited, valid(Device), asDevice, async c => {
  const db = drizzle(c.env.DB)
  const now = Date.now()
  const code = parseCode(codeOf(crypto.getRandomValues(new Uint8Array(8))))!
  await db.batch([
    db.delete(links).where(lt(links.expires, now)),
    db.insert(links).values({ code, device: c.get("who").device, expires: now + LINK_TTL })
  ])
  return c.json({ code, expires: now + LINK_TTL }, 201)
})

const Code = v.pipe(v.string(), v.transform(parseCode), v.string("Not a code"))

social.post("/api/link/:code", on("link"), limited, valid(v.object({ code: Code }), "param"), valid(Device), asDevice, async c => {
  const db = drizzle(c.env.DB)
  const who = c.get("who")
  const [link] = await db.select().from(links).where(and(eq(links.code, c.req.valid("param").code), gt(links.expires, Date.now()), eq(links.linked, false)))
  if (!link)
    return c.text("No such code, or it's expired", 404)
  const [other] = await db.select({ person: devices.person }).from(devices).where(eq(devices.id, link.device))
  if (!other || other.person === who.person)
    return c.text("That device is already yours", 409)
  await db.batch([...join(db, other.person, who.person), db.update(links).set({ linked: true }).where(eq(links.code, link.code))])
  return c.json({ linked: true })
})

// The new device asks whether its code has been approved
social.get("/api/link/:code", on("link"), valid(v.object({ code: Code }), "param"), async c => {
  const who = await maybeDevice(c)
  if (!who)
    return c.text("Not this device's", 401)
  const [link] = await drizzle(c.env.DB).select({ linked: links.linked, expires: links.expires }).from(links).where(and(eq(links.code, c.req.valid("param").code), eq(links.device, who.device)))
  return link ? c.json({ linked: link.linked, expires: link.expires }, 200, { "cache-control": "no-store" }) : c.notFound()
})

//#endregion

//#region Email

const Address = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(120), v.regex(UNH, "A UNH address: @unh.edu or @wildcats.unh.edu"))

// Sends a six-digit code to a UNH address, for the person asking to type back, or to confirm from the message's link
social.post("/api/email", on("email"), limited, valid(v.object({ ...Device.entries, address: Address })), asDevice, async c => {
  const db = drizzle(c.env.DB)
  const { address } = c.req.valid("json")
  const now = Date.now()
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0")
  const attempt = { pending: c.get("who").person, code: await sha256(code), expires: now + CODE_TTL, tries: 0 }
  await db.insert(emails).values({ address, ...attempt }).onConflictDoUpdate({ target: emails.address, set: attempt })
  const confirm = `${SITE}/map/#verify=${encodeURIComponent(address)}:${code}`
  try {
    await send(c.env, {
      to:      address,
      subject: `${code} is your notunh code`,
      text:    `${code}\n\nYour notunh code, good for 10 minutes. Or open this and tap Confirm:\n${confirm}\n\nNot you? Ignore this.`
    })
  }
  catch (error) {
    console.error("[mail]", (error as { code?: string }).code ?? error)
    return c.text("Couldn't send the code; try again later", 502)
  }
  return c.json({ sent: true, expires: attempt.expires })
})

social.post("/api/email/verify", on("email"), limited, valid(v.object({ ...Device.entries, address: Address, code: v.pipe(v.string(), v.regex(/^\d{6}$/)) })), asDevice, async c => {
  const db = drizzle(c.env.DB)
  const who = c.get("who")
  const { address, code } = c.req.valid("json")
  const now = Date.now()
  const [row] = await db.select().from(emails).where(eq(emails.address, address))
  if (!row?.code || row.pending !== who.person || row.expires === null || row.expires < now || row.tries >= CODE_TRIES)
    return c.text("No code to check; ask for another", 404)
  if (row.code !== await sha256(code)) {
    await db.update(emails).set({ tries: row.tries + 1 }).where(eq(emails.address, address))
    return c.text(row.tries + 1 >= CODE_TRIES ? "Too many tries; ask for another code" : "Not the code", 403)
  }
  // An address another of your devices verified within the year is that person's, so this device joins them, as
  // recovering it after its storage and cookie are gone; otherwise it's this device's person's from now on
  const holder = row.person && row.person !== who.person && row.verified !== null && row.verified > now - VERIFIED_FOR ? row.person : undefined
  const verify = db.update(emails).set({ person: holder ?? who.person, verified: now, pending: null, code: null, expires: null, tries: 0 }).where(eq(emails.address, address))
  await (holder ? db.batch([...join(db, who.person, holder), verify]) : verify)
  return c.json({ verified: address, joined: holder !== undefined })
})

//#endregion

//#region Your things, kept for you

// Your things as this device has written them since it last asked, each kept where it's newer than what's kept, and
// all of them as kept for your person answered, for the device to take what's newer than its own
social.post("/api/state", on("sync"), limited, valid(v.object({ ...Device.entries, entries: Entries })), asDevice, async c => {
  const db = drizzle(c.env.DB)
  const { person } = c.get("who")
  const now = Date.now()
  // A device's clock running ahead would win every write after it, so a write is never later than now
  const rows = Object.entries(c.req.valid("json").entries).flatMap(([key, entry]) => entry && isSynced(key) ? [{ person, key, value: entry.value, at: Math.min(entry.at, now), by: entry.by }] : [])
  if (rows.length)
    await db.insert(state).values(rows).onConflictDoUpdate({
      target:   [state.person, state.key],
      set:      keptIfNewer,
      setWhere: isNewerRow
    })
  const kept = await db.select({ key: state.key, value: state.value, at: state.at, by: state.by }).from(state).where(eq(state.person, person))
  return c.json({ entries: Object.fromEntries(kept.map(({ key, ...entry }) => [key, entry])) }, 200, { "cache-control": "no-store" })
})

// The device's id and secret from the cookie that keeps them, for a device whose own storage lost them to take back
social.get("/api/session", on("sync"), async c => {
  const credential = credentialOf(c, undefined, true)
  const who = await asked(c.env, credential)
  if (!who)
    return c.text("No device here", 401)
  c.header("set-cookie", cookieOf(credential!, isSecure(c)))
  return c.json(credential, 200, { "cache-control": "no-store" })
})

//#endregion

// Who the asking device is: its person, and the UNH address verified for it, if any
social.get("/api/me", async c => {
  const who = await maybeDevice(c)
  if (!who)
    return c.text("Not this device's", 401)
  return c.json({ person: who.person, verified: await verifiedOf(drizzle(c.env.DB), who.person, Date.now()) ?? null }, 200, { "cache-control": "no-store" })
})

/**
 * Whether a read is asked by a device, by its secret or cookie, whose person holds a verified UNH address. Asked
 * without making the device one, as a read alone never does
 */
export const isVerifiedAsker = async (c: Asking) => {
  const named = c.req.query("device")
  const credential = credentialOf(c, named && v.is(ID, named) ? named : undefined)
  const who = credential && await whoIs(c.env, credential)
  return who !== undefined && await verifiedOf(drizzle(c.env.DB), who.person, Date.now()) !== undefined
}

/** A pin anyone may read by its id, or none for an id that isn't one, or a pin gone or hidden */
export const publicPin = (db: D1Database, id: string) =>
  v.is(ID, id) ? readPin(drizzle(db), id, undefined) : Promise.resolve(undefined)

/** Drops pins long over, with everything of theirs, and codes expired, as the nightly prune */
export const pruneSocial = (db: ReturnType<typeof drizzle>, now: number) =>
  [...dropPins(db, lt(pins.end, now - LINGER)), db.delete(links).where(lt(links.expires, now))]
