// Reminders, one SQLite-backed Durable Object per device: its push subscription, and each reminder's watch on a run
// (src/reminders/watch.mts). Its one alarm is always the soonest check. A check forecasts every due run at once with
// the model from the Worker's own samples (src/reminders/forecast.mts): the last minutes of fixes and the latest
// predictions from D1, the buses followed across every route, and buildRuns on the whole timetable, with the
// timetable and model the site serves, read once an hour and parsed once a release for every object in the isolate.
// A device's object forgets everything 30 days after its last reminder, at once when its push service says the
// subscription's gone, or when asked

import * as v from "valibot"
import { type Feed, loadFeed } from "../src/transit/feed.mts"
import { type Model, asModel } from "../src/transit/models/model.mts"
import type { Run } from "../src/transit/models/forecast.mts"
import { type ObservedRow, decode, observe } from "../src/transit/observations/raw.mts"
import { NO_FORECAST, forecastOfSample } from "../src/transit/observations/predictions.mts"
import { runsAt, scheduledOnly, scheduledRuns, seenOf } from "../src/reminders/forecast.mts"
import { type Seen, type Wake, type Watched, FURTHEST, FURTHEST_FIXED, GONE, WAKE_VERSION, Watch, check, pushOf, replaced, retried } from "../src/reminders/watch.mts"
import { localDay } from "../src/shared/time.mts"
import { getOrCreate } from "../src/shared/group.mts"
import { type Vapid, Subscription, push } from "./push.mts"
import type { Env } from "./env.mts"
import { dataOf, siteBuild } from "./site.mts"

/** ms a device is kept after its last reminder ends */
export const FORGET_MS = 30 * 86_400_000
/** Reminders a device may have at once */
export const MAX_REMINDERS = 10
/** ms of samples a check reads: enough fixes to follow each bus through a few stops and settle its pace */
export const WINDOW_MS = 10 * 60_000
/** ms before the site's timetable and model are looked for again, as the nightly build replaces them, and sooner after they couldn't be read */
const SITE_MS = 3600_000
export const SITE_RETRY_MS = 60_000
/** ms before checking again when the Worker has no push keys, which a deploy may yet set */
const NO_KEYS_MS = 3600_000

export const Setting = v.object({ subscription: Subscription, watch: Watch })

/** What the object is asked, by the Worker's routes (api.mts), each with the device's secret */
export type Ask =
  | { kind: "set", id: string, secret: string } & v.InferOutput<typeof Setting>
  | { kind: "cancel", id: string, secret: string }
  | { kind: "forget", secret: string }

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, "0")).join("")

/** The Worker's VAPID keys, or none where reminders aren't set up, as in Previews */
export const vapidOf = (env: Env): Vapid | undefined =>
  env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT ?? "https://notunh.app" } : undefined

type Device = { secret: string, endpoint: string, p256dh: string, auth: string, touched: number }
/** A reminder's row: its watch, and a stamp of its setting, so a check begun before it was replaced leaves it be */
type Row = { id: string, stamp: string, watched: Watched }
/** A release's timetable and model, and the timetable's own runs by local service day, for telling a run the source dropped from one it no longer has */
type Site = { release: string, feed: Feed, model: Model, scheduled: Map<string, Run[]> }

// The tables, made on a device's first reminder, and again after the object forgets everything, which drops them
const TABLES = `
  create table if not exists device (id integer primary key check (id = 1), secret text not null, endpoint text not null, p256dh text not null, auth text not null, touched integer not null);
  create table if not exists reminders (id text primary key, next integer, stamp text not null, state text not null);
`

// Each release's timetable and model, parsed once for every object in the isolate
const sites = new Map<string, Promise<Site>>()

/** The site's timetable and model, from the map page's head, which is the build's own manifest (src/shell/manifest.mts), parsed once a release */
const siteOf = async (assets: Fetcher): Promise<Site> => {
  const { release, data } = await siteBuild(assets)
  if (!data.gtfs || !data.model)
    throw new Error("The map page names no timetable or model")
  const key = `${release} ${data.gtfs} ${data.model}`
  if (!sites.has(key))
    sites.clear()
  const site = getOrCreate(sites, key, () => Promise.all([
    dataOf(assets, data.gtfs, loadFeed),
    dataOf(assets, data.model, response => response.json().then(asModel))
  ]).then(([feed, model]) => ({ release, feed, model, scheduled: new Map() })))
  site.catch(() => sites.delete(key))
  return site
}

export class Reminders implements DurableObject {
  private readonly ctx: DurableObjectState
  private readonly env: Env
  /** The site's timetable and model as last read, and when to look for them again */
  private site?: Site
  private siteDue = 0

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }

  /** Whether the object knows a device: its tables are made on a device's first reminder and dropped with it */
  private isKnown = () =>
    this.ctx.storage.sql.exec("select 1 from sqlite_master where name = 'device'").toArray().length > 0

  private device = () =>
    this.isKnown() ? this.ctx.storage.sql.exec<Device>("select secret, endpoint, p256dh, auth, touched from device").toArray()[0] : undefined

  /** Each reminder as kept, dropping any of a shape from before watches had a time, which nothing could check */
  private reminders = (): Row[] => {
    if (!this.isKnown())
      return []
    const rows = this.ctx.storage.sql.exec<{ id: string, stamp: string, state: string }>("select id, stamp, state from reminders").toArray()
      .map(({ id, stamp, state }) => ({ id, stamp, watched: JSON.parse(state) as Watched }))
    for (const { id, watched } of rows)
      if (typeof watched.at !== "number")
        this.ctx.storage.sql.exec("delete from reminders where id = ?", id)
    return rows.filter(({ watched }) => typeof watched.at === "number")
  }

  /** A reminder as it stands, due next at its owed push's try, else its check, or never once it's over, which the alarm prunes at its end */
  private save = ({ id, stamp, watched }: Row) => {
    const next = watched.owed?.at ?? watched.next
    this.ctx.storage.sql.exec(
      "insert or replace into reminders (id, next, stamp, state) values (?, ?, ?, ?)",
      id, next === undefined ? null : Math.round(next * 1000), stamp, JSON.stringify(watched)
    )
  }

  /** A reminder as it stands now, if it's still the one it was when a check began, and the device's still known */
  private unchanged = ({ id, stamp }: Row) =>
    this.reminders().find(row => row.id === id && row.stamp === stamp)

  /** The alarm at the soonest check, or at forgetting the device, or none once it's forgotten */
  private schedule = async () => {
    const [{ next }] = this.ctx.storage.sql.exec<{ next: number | null }>("select min(next) as next from reminders").toArray()
    const device = this.device()
    if (next !== null)
      await this.ctx.storage.setAlarm(next)
    else if (device)
      await this.ctx.storage.setAlarm(device.touched + FORGET_MS)
    else
      await this.ctx.storage.deleteAlarm()
  }

  private forget = async () => {
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  /** The site's timetable and model, looked for anew once an hour, or a minute after they couldn't be read, keeping the last read meanwhile */
  private siteAt = async (now: number) => {
    if (now >= this.siteDue)
      try {
        this.site = await siteOf(this.env.ASSETS)
        this.siteDue = now + SITE_MS
      }
      catch (error) {
        console.warn(`The timetable and model couldn't be read, so the reminders go by ${this.site ? "the last read" : "the timetable they were set from"}`, error)
        this.siteDue = now + SITE_RETRY_MS
      }
    return this.site
  }

  /**
   * What the Worker's samples of the last WINDOW_MS say at an instant, read once a check for every due reminder:
   * the fixes, and the source's latest predictions as a forecast, or none without a row. Both sources are named, so
   * the rows are found by the table's key rather than by reading it through
   */
  private samplesAt = async (now: number) => {
    const { results } = await this.env.DB.prepare("select source, at, body from samples where source in ('buses', 'predictions') and at > ? order by at")
      .bind(now - WINDOW_MS)
      .all<{ source: ObservedRow["source"], at: number, body: ArrayBuffer }>()
    const rows = await Promise.all(results.map(async ({ source, at, body }) => ({ source, at, ...await decode(new Uint8Array(body)) }) as ObservedRow))
    const { fixes, predictions } = observe(rows)
    const latest = predictions.at(-1)
    return { fixes, forecast: latest ? forecastOfSample(latest) : NO_FORECAST }
  }

  /**
   * What the forecast says of each due watch at an epoch second, from the samples read and the day's runs built
   * once for all of them. Watches on no run are their fixed times, which need neither
   */
  private seen = async (watches: readonly Watch[], now: number): Promise<(Seen | undefined)[]> => {
    if (watches.every(watch => !watch.run))
      return watches.map(watch => scheduledOnly(watch, now))
    const site = await this.siteAt(now * 1000)
    if (!site)
      return watches.map(watch => scheduledOnly(watch, now))
    try {
      const { fixes, forecast } = await this.samplesAt(now * 1000)
      const runs = runsAt(site.feed, site.model, fixes, forecast, now)
      const scheduled = () => getOrCreate(site.scheduled, localDay(now * 1000), () => scheduledRuns(site.feed, site.model, now))
      return watches.map(watch => seenOf(site.feed, runs, scheduled, watch, now))
    }
    catch (error) {
      console.warn("The samples couldn't be read, so the reminders go on with what they knew", error)
      return watches.map(() => undefined)
    }
  }

  /**
   * The first reminder from a device sets its secret, which every ask after goes by, as its SHA-256. A device it
   * doesn't know can only set one, and asking it anything else leaves nothing behind
   */
  async fetch(request: Request) {
    const ask = await request.json<Ask>()
    const hash = await sha256(ask.secret)
    const now = Date.now()
    const device = this.device()
    if (device ? device.secret !== hash : ask.kind !== "set")
      return new Response("Not this device's", { status: 403 })
    if (ask.kind === "forget")
      await this.forget()
    else if (ask.kind === "cancel") {
      this.ctx.storage.sql.exec("delete from reminders where id = ?", ask.id)
      await this.schedule()
    }
    else {
      if (device && this.reminders().filter(({ id }) => id !== ask.id).length >= MAX_REMINDERS)
        return new Response(`At most ${MAX_REMINDERS} reminders at once`, { status: 409 })
      if (ask.watch.at + GONE < now / 1000)
        return new Response("The time has gone", { status: 400 })
      if (ask.watch.at > now / 1000 + (ask.watch.run ? FURTHEST : FURTHEST_FIXED))
        return new Response("Too far ahead", { status: 400 })
      const { endpoint, keys } = ask.subscription
      this.ctx.storage.sql.exec(TABLES)
      this.ctx.storage.sql.exec(
        "insert or replace into device (id, secret, endpoint, p256dh, auth, touched) values (1, ?, ?, ?, ?, ?)",
        hash, endpoint, keys.p256dh, keys.auth, now
      )
      // Set again on the same run, as the phone plans a kept trip afresh, it goes on as told
      const was = this.reminders().find(({ id }) => id === ask.id)?.watched
      this.save({ id: ask.id, stamp: crypto.randomUUID(), watched: replaced(was, ask.watch, now / 1000) })
      await this.schedule()
    }
    return new Response(null, { status: 204 })
  }

  /** A due reminder checked against what's foretold of its run, and saved as it goes on, owing a push if the check made one */
  private evaluate = (row: Row, seen: Seen | undefined, at: number): Row => {
    const { watched, push } = check(row.watched, seen, at)
    const wake: Wake | undefined = push && { v: WAKE_VERSION, reminder: row.id, kind: push, seen: seen ?? scheduledOnly(row.watched, at), at }
    const checked = { ...row, watched: { ...watched, owed: wake && { wake, tries: 0, at } } }
    this.save(checked)
    return checked
  }

  /**
   * Sends a reminder's owed push, and keeps what came of it: taken, it's owed no more; not taken now, it's tried
   * again later, a few times; the subscription gone, the device is forgotten, unless the phone has subscribed anew
   * meanwhile, whose pushes still reach it. Other asks of the object arrive while the push service is awaited, so a
   * reminder replaced or cancelled by then, or a device forgotten, is left as they left it
   */
  private deliver = async (row: Row, device: Device, vapid: Vapid, at: number) => {
    const { wake } = row.watched.owed!
    const subscription: Subscription = { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }
    // Of no use once the bus is long gone, and a newer push of the same reminder replaces it while it waits
    const ttl = Math.max(60, Math.max(wake.seen.time, row.watched.at) + GONE - at)
    const sent = await push(subscription, pushOf(wake), vapid, { ttl, topic: row.id.slice(0, 32) }, at)
    if (sent.sent === "gone") {
      if (this.device()?.endpoint === device.endpoint)
        await this.forget()
      return
    }
    const current = this.unchanged(row)
    if (current)
      this.save({ ...current, watched: sent.sent === "retry" ? retried(current.watched, at, sent.after) : { ...current.watched, owed: undefined } })
  }

  /**
   * Delivers what's owed, as after a push the service couldn't take or an object evicted between making a push and
   * sending it, then checks every reminder that's due, with one read of the samples for all their runs. A push is
   * saved as owed before it's sent, and alarms run at least once, so no push is lost and none is made twice
   */
  async alarm() {
    const vapid = vapidOf(this.env)
    const now = Date.now()
    const device = this.device()
    if (!device)
      return this.forget()
    if (!vapid) {
      console.warn("The Worker has no push keys, so the reminders wait for a deploy that sets them")
      return this.ctx.storage.setAlarm(now + NO_KEYS_MS)
    }
    const at = now / 1000
    // A little early, as alarms can be, counts as due, rather than setting the same alarm again
    const isDue = (time: number | undefined) => time !== undefined && time * 1000 <= now + 1000
    for (const row of this.reminders().filter(({ watched: { owed } }) => isDue(owed?.at)))
      await this.deliver(row, device, vapid, at)
    // A reminder owing a push waits on it rather than being checked again
    const due = this.reminders().filter(({ watched: { next, owed } }) => !owed && isDue(next))
    if (due.length) {
      const seen = await this.seen(due.map(({ watched }) => watched), at)
      for (const [i, was] of due.entries()) {
        const row = this.unchanged(was)
        if (!row)
          continue
        const checked = this.evaluate(row, seen[i], at)
        if (checked.watched.owed)
          await this.deliver(checked, device, vapid, at)
      }
    }
    if (!this.isKnown())
      return
    if (!this.reminders().length && now >= device.touched + FORGET_MS)
      return this.forget()
    this.ctx.storage.sql.exec("delete from reminders where next is null")
    if (due.length)
      this.ctx.storage.sql.exec("update device set touched = ?", now)
    await this.schedule()
  }
}
