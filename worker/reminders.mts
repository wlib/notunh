// Reminders, one SQLite-backed Durable Object per device: its push subscription, and each reminder's watch on a run
// (src/reminders/watch.mts). Its one alarm is always the soonest check. A check forecasts the run with the model
// from the Worker's own samples (src/reminders/forecast.mts): the last minutes of fixes and the latest predictions
// from D1, the buses of the run's route followed through the location model, and buildRuns on the route's trips, with
// the timetable and model the site serves, read once an hour. A device's object forgets everything 30 days after its
// last reminder, at once when its push service says the subscription's gone, or when asked

import * as v from "valibot"
import { type Feed, loadFeed } from "../src/transit/feed.mts"
import { type Model, asModel } from "../src/transit/models/model.mts"
import { sightingsFrom } from "../src/transit/models/tracking.mts"
import { type ObservedRow, decode, observe } from "../src/transit/observations/raw.mts"
import { NO_FORECAST, forecastFrom } from "../src/transit/observations/predictions.mts"
import { routeFeed, scheduledOnly, seenOf } from "../src/reminders/forecast.mts"
import { type Seen, type Watched, GONE, MIN_CHECK, Watch, check, pushOf, watched } from "../src/reminders/watch.mts"
import { buildOf } from "../src/shell/manifest.mts"
import { type Vapid, Subscription, push } from "./push.mts"
import type { Env } from "./collect.mts"

/** ms a device is kept after its last reminder ends */
export const FORGET_MS = 30 * 86_400_000
/** Reminders a device may have at once */
export const MAX_REMINDERS = 10
/** ms of samples a check reads: enough fixes to follow each bus through a few stops and settle its pace */
export const WINDOW_MS = 10 * 60_000
/** ms the site's timetable and model are kept before they're read again, as the nightly build replaces them */
const SITE_MS = 3600_000

export const Setting = v.object({ secret: v.pipe(v.string(), v.minLength(16), v.maxLength(200)), subscription: Subscription, watch: Watch })

/** What the object is asked, by the Worker's routes (api.mts) */
export type Ask =
  | { kind: "set", id: string } & v.InferOutput<typeof Setting>
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
/** The timetable and model the site serves, as read at an instant, and the timetable cut to each route asked for */
type Site = { at: number, feed: Feed, model: Model, routes: Map<string, Feed> }

/** The site's timetable and model, from the map page's head, as a page loads them */
const siteOf = async (assets: Fetcher, at: number): Promise<Site> => {
  const page = await assets.fetch("https://notunh.app/map/")
  if (!page.ok)
    throw new Error(`The map page is ${page.status}`)
  const { data } = buildOf(await page.text())
  if (!data.gtfs || !data.model)
    throw new Error("The map page names no timetable or model")
  const [feed, model] = await Promise.all([
    assets.fetch(new URL(data.gtfs, "https://notunh.app").href).then(loadFeed),
    assets.fetch(new URL(data.model, "https://notunh.app").href).then(response => response.json()).then(asModel)
  ])
  return { at, feed, model, routes: new Map() }
}

export class Reminders implements DurableObject {
  private readonly ctx: DurableObjectState
  private readonly env: Env
  private site?: Promise<Site>

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
    ctx.storage.sql.exec(`
      create table if not exists device (id integer primary key check (id = 1), secret text not null, endpoint text not null, p256dh text not null, auth text not null, touched integer not null);
      create table if not exists reminders (id text primary key, next integer, stamp text not null, state text not null);
    `)
  }

  private device = () =>
    this.ctx.storage.sql.exec<Device>("select secret, endpoint, p256dh, auth, touched from device").toArray()[0]

  private reminders = (): Row[] =>
    this.ctx.storage.sql.exec<{ id: string, stamp: string, state: string }>("select id, stamp, state from reminders").toArray()
      .map(({ id, stamp, state }) => ({ id, stamp, watched: JSON.parse(state) as Watched }))

  /** A reminder as it stands, with no next check once it's over, which the alarm prunes at its end */
  private save = ({ id, stamp, watched }: Row) =>
    this.ctx.storage.sql.exec(
      "insert or replace into reminders (id, next, stamp, state) values (?, ?, ?, ?)",
      id, watched.next === undefined ? null : Math.round(watched.next * 1000), stamp, JSON.stringify(watched)
    )

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

  /** The site's timetable and model, read anew once an hour, or none when they can't be read */
  private siteAt = async (now: number) => {
    const kept = await this.site?.catch(() => undefined)
    if (kept && now - kept.at < SITE_MS)
      return kept
    this.site = siteOf(this.env.ASSETS, now)
    return this.site.catch(error => {
      console.warn("The timetable and model couldn't be read, so the reminders go by the timetable they were set from", error)
      return undefined
    })
  }

  /**
   * What the Worker's samples of the last WINDOW_MS say at an instant, read once a check for every due reminder:
   * the fixes, and the source's latest predictions as a forecast, or none without a row
   */
  private samplesAt = async (now: number) => {
    const { results } = await this.env.DB.prepare("select source, at, body from samples where at > ? order by at")
      .bind(now - WINDOW_MS)
      .all<{ source: ObservedRow["source"], at: number, body: ArrayBuffer }>()
    const rows = await Promise.all(results.map(async ({ source, at, body }) => ({ source, at, ...await decode(new Uint8Array(body)) }) as ObservedRow))
    const { fixes, predictions } = observe(rows)
    const latest = predictions.at(-1)
    return { fixes, forecast: latest ? forecastFrom(latest.predictions.map(({ at, isLayover, ...rest }) => ({ ...rest, time: at / 1000, isLive: !isLayover })), latest.at / 1000) : NO_FORECAST }
  }

  /** What the forecast says of each due watch at an epoch second, from the samples and site read once for all of them */
  private seen = async (watches: readonly Watch[], now: number): Promise<(Seen | undefined)[]> => {
    const site = await this.siteAt(now * 1000)
    if (!site)
      return watches.map(watch => scheduledOnly(watch, now))
    try {
      const { fixes, forecast } = await this.samplesAt(now * 1000)
      const sightings = new Map<string, ReturnType<typeof sightingsFrom>>()
      return watches.map(watch => {
        const feed = site.routes.get(watch.route) ?? site.routes.set(watch.route, routeFeed(site.feed, watch.route)).get(watch.route)!
        const seeing = sightings.get(watch.route) ?? sightings.set(watch.route, sightingsFrom(feed, site.model, fixes.filter(fix => fix.route === watch.route))).get(watch.route)!
        return seenOf(feed, site.model, watch, seeing(now), forecast, now)
      })
    }
    catch (error) {
      console.warn("The samples couldn't be read, so the reminders go on with what they knew", error)
      return watches.map(() => undefined)
    }
  }

  /** The first reminder from a device sets its secret, which every ask after goes by, as its SHA-256 */
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
      if (this.reminders().filter(({ id }) => id !== ask.id).length >= MAX_REMINDERS)
        return new Response(`At most ${MAX_REMINDERS} reminders at once`, { status: 429 })
      if (ask.watch.scheduled + GONE < now / 1000)
        return new Response("The bus has gone", { status: 400 })
      const { endpoint, keys } = ask.subscription
      this.ctx.storage.sql.exec(
        "insert or replace into device (id, secret, endpoint, p256dh, auth, touched) values (1, ?, ?, ?, ?, ?)",
        hash, endpoint, keys.p256dh, keys.auth, now
      )
      this.save({ id: ask.id, stamp: crypto.randomUUID(), watched: watched(ask.watch, now / 1000) })
      await this.schedule()
    }
    return new Response(null, { status: 204 })
  }

  /**
   * Checks every reminder that's due, with one read of the samples for all their runs. Other asks of the object
   * arrive while the samples and the push service are awaited, so a reminder replaced or cancelled meanwhile is left
   * as they left it. A push is saved as made before it's sent, so an alarm retried after a push doesn't push again,
   * at the cost of a push lost to a crash between
   */
  async alarm() {
    const device = this.device()
    const vapid = vapidOf(this.env)
    const now = Date.now()
    if (!device || !vapid)
      return this.forget()
    // A little early, as alarms can be, counts as due, rather than setting the same alarm again
    const due = this.reminders().filter(({ watched: { next } }) => next !== undefined && next * 1000 <= now + 1000)
    if (!due.length)
      return now >= device.touched + FORGET_MS && !this.reminders().length ? this.forget() : this.schedule()

    const at = now / 1000
    const seen = await this.seen(due.map(({ watched }) => watched), at)
    const subscription: Subscription = { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }
    const unchanged = ({ id, stamp }: Row) => this.reminders().find(row => row.id === id && row.stamp === stamp)
    for (const [i, was] of due.entries()) {
      const row = unchanged(was)
      if (!row)
        continue
      const result = check(row.watched, seen[i], at)
      this.save({ ...row, watched: result.watched })
      if (!result.push)
        continue
      const wake = { reminder: row.id, kind: result.push, seen: seen[i] ?? scheduledOnly(row.watched, at), at }
      // Of no use once the bus is long gone, and a newer push of the same reminder replaces it while it waits
      const sent = await push(subscription, pushOf(wake), vapid, { ttl: Math.max(60, Math.max(wake.seen.time, row.watched.scheduled) + GONE - at), topic: row.id.slice(0, 32) }, at)
      if (sent === "gone")
        return this.forget()
      // Not taken this time, so it's tried again at the next check, as though it hadn't been due
      if (sent === "retry" && unchanged(row))
        this.save({ ...row, watched: { ...row.watched, next: at + MIN_CHECK } })
    }
    this.ctx.storage.sql.exec("delete from reminders where next is null")
    this.ctx.storage.sql.exec("update device set touched = ?", now)
    await this.schedule()
  }
}
