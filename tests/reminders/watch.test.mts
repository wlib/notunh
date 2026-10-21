import { test, expect } from "vitest"
import fc from "fast-check"
import { type Kind, type Seen, type Watch, type Watched, FOLLOW, GONE, LATEST, MAX_PUSHES, MAX_TRIES, MIN_CHECK, SHIFT, WAKE_VERSION, Wake, check, pushOf, replaced, retried, watched } from "../../src/reminders/watch.mts"
import * as v from "valibot"

const NOW = 1_790_000_000
const TRIP = "3B FULL_T04"

/** A watch on a run due `ahead` seconds from now, as the phone asks for one (reminder.mts) */
const watch = fc.record({ ahead: fc.integer({ min: 0, max: 3 * 3600 }), lead: fc.integer({ min: 60, max: 3600 }) })
  .map(({ ahead, lead }) => ({ at: NOW + ahead, lead, run: { stop: "101", route: "3", trip: TRIP } } satisfies Watch))

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
  let time = start.at
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
    const earliest = watch.at - pushes[0].seen!.band
    expect(earliest - pushes[0].at).toBeLessThanOrEqual(watch.lead)
    if (earliest - watch.lead > NOW)
      expect(earliest - pushes[0].at).toBeGreaterThanOrEqual(watch.lead - MIN_CHECK)
    // Halving the wait to the wake, then following the bus a minute at a time past the stop
    expect(checks.length).toBeLessThanOrEqual(Math.ceil(Math.log2(watch.at - NOW + 1)) + (watch.lead + GONE) / FOLLOW + 4)
    for (const status of ["cancelled", "lost", "passed"] as const) {
      const over = run(watched(watch, NOW), { drifts: [], bands: [], silences: [], goneFrom: { at: 0, status }, isLiveFrom: 0 }).pushes
      expect(over.map(({ kind }) => kind)).toEqual(["over"])
    }
  }))
})

test("an update comes only for the bus moving by minutes or being cancelled after the phone's told, a late check still says due while it's near, and a run never forecast ends once it's long past", () => {
  const start = watched({ at: NOW + 1800, lead: 600, run: { stop: "101", route: "3", trip: TRIP } }, NOW)
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
    const told: Watched = { ...watched({ at: NOW + ahead, lead: 600, run: { stop: "101", route: "3", trip: TRIP } }, NOW), pushes: 1, told: { time: NOW + ahead, by: NOW + ahead - 60 }, next: NOW + FOLLOW, owed: { wake, tries: 0, at: NOW } }
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

test("a watch on no run pushes exactly once, due at its time less its lead, after one check more, and never updates", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 36 * 3600 }), fc.integer({ min: 60, max: 3600 }), (ahead, lead) => {
    const fixed: Watch = { at: NOW + ahead, lead }
    let state = watched(fixed, NOW)
    const pushes: { kind: Kind, at: number }[] = []
    const checks: number[] = []
    // Checked as the Worker's alarm would, with its fixed time as a check sees it
    for (let i = 0; state.next !== undefined; i++) {
      expect(i).toBeLessThan(5)
      const at = state.next
      checks.push(at)
      const seen: Seen = { time: fixed.at, band: 0, isLive: false, status: at > fixed.at + GONE ? "passed" : "coming" }
      const { watched, push } = check(state, seen, at)
      if (push)
        pushes.push({ kind: push, at })
      state = watched
    }
    expect(pushes.map(({ kind }) => kind)).toEqual(["due"])
    expect(pushes[0].at).toBe(Math.max(NOW, fixed.at - lead))
    expect(checks.length).toBeLessThanOrEqual(2)
    // Checked on again anyway, as with a check that couldn't be made, it still says nothing more
    expect(check({ ...state, next: pushes[0].at + FOLLOW }, { time: fixed.at, band: 0, isLive: false, status: "coming" }, pushes[0].at + FOLLOW).push).toBeUndefined()
  }))
})

test("an update comes when the time less the band moves earlier by SHIFT, though the time alone hasn't, and not for a band narrowing as the bus nears", () => {
  const start = watched({ at: NOW + 1800, lead: 600, run: { stop: "101", route: "3", trip: TRIP } }, NOW)
  const seen = (time: number, band: number): Seen => ({ time, band, isLive: true, status: "coming" })
  const told = check(start, seen(NOW + 1800, 180), NOW + 1200)
  expect(told).toMatchObject({ push: "due", watched: { told: { time: NOW + 1800, by: NOW + 1800 - 180 } } })
  // The bus's time stands, but it's become unsure enough to need being at the stop SHIFT earlier
  expect(check(told.watched, seen(NOW + 1800, 180 + SHIFT - 1), told.watched.next!).push).toBeUndefined()
  expect(check(told.watched, seen(NOW + 1800, 180 + SHIFT), told.watched.next!)).toMatchObject({ push: "update", watched: { told: { time: NOW + 1800, by: NOW + 1800 - 180 - SHIFT } } })
  // Surer of it as it nears, there's no news, and a bus later by SHIFT is news whatever its band
  expect(check(told.watched, seen(NOW + 1800, 30), told.watched.next!).push).toBeUndefined()
  expect(check(told.watched, seen(NOW + 1800 + SHIFT, 30), told.watched.next!).push).toBe("update")
  fc.assert(fc.property(fc.integer({ min: -600, max: 600 }), fc.integer({ min: 0, max: 600 }), (drift, band) => {
    const { push } = check(told.watched, seen(NOW + 1800 + drift, band), told.watched.next!)
    const { time, by } = told.watched.told!
    expect(push === "update").toBe(NOW + 1800 + drift - band <= by - SHIFT || NOW + 1800 + drift >= time + SHIFT)
  }))
})

test("a forecast that has the bus past the stop before its scheduled time has gone is no news, as a followed bus can be placed ahead of itself, and the watch checks on; past that time, the bus is gone", () => {
  fc.assert(fc.property(watch, fc.integer({ min: 0, max: 4 * 3600 }), fc.integer({ min: 0, max: 3600 }), (watch, elapsed, ago) => {
    const now = NOW + elapsed
    const seen: Seen = { time: now - GONE - ago, band: 60, isLive: true, status: "passed" }
    const { watched: after, push } = check(watched(watch, NOW), seen, now)
    if (now > watch.at + GONE)
      expect(push).toBe("over")
    else {
      expect(push).toBeUndefined()
      expect(after.told).toBeUndefined()
      expect(after.next).toBeGreaterThan(now)
      expect(after.next).toBeLessThanOrEqual(Math.max(now + FOLLOW, watch.at - watch.lead))
    }
  }))
})

test("a watch set again on the same run goes on as the phone was told, its pushes counted, so a lead that moved doesn't wake it twice, and on another run or time starts afresh", () => {
  fc.assert(fc.property(watch, fc.integer({ min: 60, max: 3600 }), fc.integer({ min: 0, max: MAX_PUSHES }), fc.boolean(), fc.integer({ min: 1, max: 3600 }), (watch, lead, pushes, isTold, moved) => {
    const told = isTold ? { time: watch.at + 30, by: watch.at - 60 } : undefined
    const was: Watched = { ...watch, pushes, ...told && { told }, next: NOW + FOLLOW }
    const again = replaced(was, { ...watch, lead }, NOW + 60)
    expect(again).toEqual({ ...watch, lead, pushes, ...told && { told }, next: NOW + 60 })
    expect(replaced(was, { ...watch, at: watch.at + moved }, NOW + 60)).toEqual(watched({ ...watch, at: watch.at + moved }, NOW + 60))
    expect(replaced(was, { ...watch, run: { ...watch.run!, trip: "other" } }, NOW + 60)).toEqual(watched({ ...watch, run: { ...watch.run!, trip: "other" } }, NOW + 60))
    expect(replaced(undefined, watch, NOW + 60)).toEqual(watched(watch, NOW + 60))
    // Told already, it hears no second "due" for the same bus
    if (told) {
      const { push } = check(again, { time: told.time, band: 60, isLive: true, status: "coming" }, NOW + 60)
      expect(push).toBeUndefined()
    }
  }))
})
