import { test, expect } from "vitest"
import fc from "fast-check"
import { type Kind, type Seen, type Watch, type Watched, FOLLOW, GONE, LATEST, MAX_PUSHES, MAX_TRIES, MIN_CHECK, SHIFT, WAKE_VERSION, Wake, check, pushOf, retried, watched } from "../../src/reminders/watch.mts"
import * as v from "valibot"

const NOW = 1_790_000_000
const TRIP = "3B FULL_T04"

/** A watch on a run due `ahead` seconds from now, as the phone asks for one (reminder.mts) */
const watch = fc.record({ ahead: fc.integer({ min: 0, max: 3 * 3600 }), lead: fc.integer({ min: 60, max: 3600 }) })
  .map(({ ahead, lead }) => ({ stop: "101", route: "3", trip: TRIP, scheduled: NOW + ahead, lead } satisfies Watch))

/** How the run's forecast goes as it's checked on: its time drifting, its band, checks that couldn't be made, and the run cancelled or lost from some check on */
const story = fc.record({
  drifts:      fc.array(fc.integer({ min: -240, max: 240 }), { maxLength: 400 }),
  bands:       fc.array(fc.integer({ min: 30, max: 480 }), { maxLength: 400 }),
  silences:    fc.array(fc.boolean(), { maxLength: 400 }),
  goneFrom:    fc.option(fc.record({ at: fc.nat(60), status: fc.constantFrom("cancelled" as const, "lost" as const, "passed" as const) }), { nil: undefined }),
  isLiveFrom:  fc.nat(30)
})
type Story = { drifts: number[], bands: number[], silences: boolean[], goneFrom?: { at: number, status: "cancelled" | "lost" | "passed" }, isLiveFrom: number }

/** Runs a watch's checks to the end, as its Durable Object's alarm would, recording each push */
const run = (start: Watched, { drifts, bands, silences, goneFrom, isLiveFrom }: Story) => {
  let state = start
  let time = start.scheduled
  const pushes: { kind: Kind, at: number, seen: Seen | undefined }[] = []
  const checks: number[] = []
  for (let i = 0; state.next !== undefined; i++) {
    expect(i).toBeLessThan(1000)
    const at = state.next
    checks.push(at)
    time += Math.round((drifts[i] ?? 0) / Math.max(1, i))
    const status = goneFrom !== undefined && i >= goneFrom.at ? goneFrom.status : at > time + GONE ? "passed" : "coming"
    const seen: Seen = { time, band: bands[i] ?? 60, isLive: i >= isLiveFrom, status }
    const { watched, push } = check(state, silences[i] ? undefined : seen, at)
    if (push)
      pushes.push({ kind: push, at, seen: silences[i] ? undefined : seen })
    if (watched.next !== undefined)
      expect(watched.next).toBeGreaterThan(at)
    state = watched
  }
  return { pushes, checks }
}

test("whatever the forecast does, a watch ends, pushes at most a few times, says due before anything else, and over only alone", () => {
  fc.assert(fc.property(watch, story, (watch, events) => {
    const kinds = run(watched(watch, NOW), events).pushes.map(({ kind }) => kind)
    expect(kinds.length).toBeLessThanOrEqual(MAX_PUSHES)
    if (kinds.length)
      expect(["due", "over"]).toContain(kinds[0])
    expect(kinds.slice(1).every(kind => kind === "update")).toBe(true)
    if (kinds.includes("over"))
      expect(kinds).toEqual(["over"])
  }))
})

test("a bus that keeps its time has the phone woken once, the lead before it could leave to within a check, after few checks, and one gone before it was near is said so once", () => {
  fc.assert(fc.property(watch, fc.integer({ min: 30, max: 480 }), (watch, band) => {
    const { pushes, checks } = run(watched(watch, NOW), { drifts: [], bands: [band], silences: [], goneFrom: undefined, isLiveFrom: 0 })
    expect(pushes.map(({ kind }) => kind)).toEqual(["due"])
    const earliest = watch.scheduled - pushes[0].seen!.band
    expect(earliest - pushes[0].at).toBeLessThanOrEqual(watch.lead)
    if (earliest - watch.lead > NOW)
      expect(earliest - pushes[0].at).toBeGreaterThanOrEqual(watch.lead - MIN_CHECK)
    // Halving the wait to the wake, then following the bus a minute at a time past the stop
    expect(checks.length).toBeLessThanOrEqual(Math.ceil(Math.log2(watch.scheduled - NOW + 1)) + (watch.lead + GONE) / FOLLOW + 4)
    for (const status of ["cancelled", "lost", "passed"] as const) {
      const over = run(watched(watch, NOW), { drifts: [], bands: [], silences: [], goneFrom: { at: 0, status }, isLiveFrom: 0 }).pushes
      expect(over.map(({ kind }) => kind)).toEqual(["over"])
    }
  }))
})

test("an update comes only for the bus moving by minutes or being cancelled after the phone's told, a late check still says due while it's near, and a run never forecast ends once it's long past", () => {
  const start = watched({ stop: "101", route: "3", trip: TRIP, scheduled: NOW + 1800, lead: 600 }, NOW)
  const seen = (time: number, status: Seen["status"] = "coming"): Seen => ({ time, band: 60, isLive: true, status })
  expect(check(start, seen(NOW + 1800), NOW).push).toBeUndefined()
  const told = check(start, seen(NOW + 1800), NOW + 1140)
  expect(told.push).toBe("due")
  expect(check(told.watched, seen(NOW + 1800 + SHIFT - 1), told.watched.next!).push).toBeUndefined()
  expect(check(told.watched, seen(NOW + 1800 + SHIFT), told.watched.next!).push).toBe("update")
  const cancelled = check(told.watched, seen(NOW + 1800, "cancelled"), told.watched.next!)
  expect(cancelled.push).toBe("update")
  expect(cancelled.watched.next).toBeUndefined()
  expect(check(start, seen(NOW + 1800), NOW + 1790).push).toBe("due")
  expect(check(start, undefined, NOW + 1300).watched.next).toBe(NOW + 1300 + FOLLOW)
  expect(check(told.watched, seen(NOW + 1800, "passed"), NOW + 1800 + GONE + 1).watched.next).toBeUndefined()
  expect(check(start, undefined, NOW + 1800 + LATEST + 1)).toMatchObject({ push: "over", watched: { next: undefined } })
})

test("a push is small and reads back as a wake", () => {
  const wake = fc.record({
    v:        fc.constant(WAKE_VERSION),
    reminder: fc.string({ minLength: 1, maxLength: 64 }),
    kind:     fc.constantFrom("due" as const, "update" as const, "over" as const),
    seen:     fc.record({ time: fc.integer({ min: NOW, max: NOW + 7200 }), band: fc.integer({ min: 0, max: 3600 }), isLive: fc.boolean(), status: fc.constantFrom("coming" as const, "cancelled" as const, "lost" as const, "passed" as const) }),
    at:       fc.constant(NOW)
  })
  fc.assert(fc.property(wake, wake => {
    const json = pushOf(wake)
    expect(new TextEncoder().encode(json).length).toBeLessThan(400)
    expect(v.parse(Wake, JSON.parse(json))).toEqual(wake)
  }))
})

test("a push the service can't take is owed still and tried again after a wait doubled each time, or as the service asks, and given up after a few tries or once the run is long past", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 3600 }), fc.option(fc.integer({ min: 1, max: 600 }), { nil: undefined }), (ahead, asked) => {
    const wake: Wake = { v: WAKE_VERSION, reminder: "r1", kind: "due", seen: { time: NOW + ahead, band: 60, isLive: true, status: "coming" }, at: NOW }
    const told: Watched = { ...watched({ stop: "101", route: "3", trip: TRIP, scheduled: NOW + ahead, lead: 600 }, NOW), pushes: 1, told: NOW + ahead, next: NOW + FOLLOW, owed: { wake, tries: 0, at: NOW } }
    let state = told
    const waits: number[] = []
    for (let i = 0; i < MAX_TRIES; i++) {
      const next = retried(state, NOW + i, asked)
      expect(next).toMatchObject({ pushes: 1, next: NOW + FOLLOW, owed: { wake, tries: i + 1 } })
      waits.push(next.owed!.at - (NOW + i))
      state = next
    }
    expect(waits).toEqual(asked === undefined ? [30, 60, 120, 240, 480] : waits.map(() => asked))
    expect(retried(state, NOW + MAX_TRIES, asked)).toEqual({ ...state, owed: undefined })
    expect(retried(told, NOW + ahead + LATEST + 1, asked)).toEqual({ ...told, owed: undefined })
  }))
})
