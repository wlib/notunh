import { test, expect } from "vitest"
import fc from "fast-check"
import type { Pin, Time } from "../../src/social/event.mts"
import { goingWords, isFull, isUnset, sortedTimes, spanOf } from "../../src/social/marks.mts"
import { askOf, askTag, askedId, askUrl, showAsk } from "../../src/social/ask.mts"

const NOW = Date.now()

const times = fc.array(fc.record({ start: fc.integer({ min: NOW, max: NOW + 60 * 86_400_000 }), length: fc.integer({ min: 1, max: 6 * 3_600_000 }) })
  .map(({ start, length }): Time => ({ start, end: start + length })), { minLength: 1, maxLength: 3 })

test("an event's time is to pick while it offers times and none is set, and never once one is", () =>
  fc.assert(fc.property(fc.array(fc.record({ start: fc.nat(), end: fc.nat() }), { maxLength: 3 }), fc.option(fc.nat(2), { nil: undefined }), (offered, chosen) => {
    expect(isUnset({ times: offered, chosen })).toBe(offered.length > 0 && chosen === undefined)
  }))
)

test("an official event, with no times of its own, is never to pick", () =>
  expect(isUnset({ id: "x", title: "T", start: 0, end: 1, where: "", source: "presence", url: "" })).toBe(false)
)

test("times are kept earliest first, and the window while one's to pick spans every one", () =>
  fc.assert(fc.property(times, offered => {
    const sorted = sortedTimes(offered)
    expect([...sorted].sort((a, b) => a.start - b.start)).toEqual(sorted)
    expect(new Set(sorted)).toEqual(new Set(offered))
    const span = spanOf(offered)
    for (const time of offered) {
      expect(span.start).toBeLessThanOrEqual(time.start)
      expect(span.end).toBeGreaterThanOrEqual(time.end)
    }
    expect(offered.some(time => time.start === span.start)).toBe(true)
    expect(offered.some(time => time.end === span.end)).toBe(true)
  }))
)

test("Going says the count, of the spots where there are some, and Full only to one not going when every spot's taken", () =>
  fc.assert(fc.property(fc.nat(20), fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }), fc.boolean(), (going, spots, isGoing) => {
    const words = goingWords({ going, spots, isGoing })
    const full = spots !== undefined && going >= spots
    expect(isFull({ going, spots })).toBe(full)
    expect(words).toBe(full && !isGoing ? "Full" : spots === undefined ? `Going · ${going}` : `Going · ${going} of ${spots}`)
  }))
)

test("the ask says the set time and asks Going, names the event and its place, and opens its page as Going", () =>
  fc.assert(fc.property(times, fc.string({ minLength: 1, maxLength: 80 }), fc.option(fc.string({ minLength: 1, maxLength: 80 }), { nil: undefined }), ([time], title, place) => {
    const id = "e".repeat(16)
    const ask = askOf({ id, title, start: time.start, place, where: "by the gate" } satisfies Pick<Pin, "id" | "title" | "start" | "place" | "where">)
    expect(ask.title).toMatch(/^Set for (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}:\d\d\s[AP]M · Going\?$/)
    expect(ask.body).toBe(`${title} · ${place ?? "by the gate"}`)
    expect(ask.ask).toBe(id)
    expect(askedId(askTag(id))).toBe(id)
    expect(askedId(`reminder-${id}`)).toBeUndefined()
    expect(askUrl("https://notunh.app", id)).toBe(`https://notunh.app/p/${id}#going`)
  }))
)

test("an ask shows once an event, replacing the one before it", async () => {
  const shown: { title: string, tag: string, closed: boolean }[] = []
  const registration = {
    showNotification: async (title: string, { tag }: { tag: string }) => void shown.push({ title, tag, closed: false }),
    getNotifications: async ({ tag }: { tag?: string } = {}) => shown.filter(each => each.tag === tag && !each.closed).map(each => ({ close: () => void (each.closed = true) }))
  }
  const id = "e".repeat(16)
  const ask = askOf({ id, title: "Tennis", start: NOW, place: "Field House", where: "" })
  await showAsk(registration, ask, "/icon-192.png")
  await showAsk(registration, ask, "/icon-192.png")
  await showAsk(registration, askOf({ ...ask, id: "f".repeat(16), title: "Chess", start: NOW, place: "MUB", where: "" }), "/icon-192.png")
  expect(shown.filter(each => !each.closed).map(({ tag }) => askedId(tag))).toEqual([id, "f".repeat(16)])
})
