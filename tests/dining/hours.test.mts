import { test, expect } from "vitest"
import fc from "fast-check"
import { hallHours, nutrisliceHours, parseUnhHours, type NutrisliceSchool, type UnhDay } from "../../scripts/dining/hours.mts"
import { addDays, spansOn, status, type WallTime } from "../../src/dining/hours.mts"
import type { Hours, Span } from "../../src/dining/menus.mts"

const DAY = 1440
const LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const NOTES = ["Early Close - U-Day", "Brunch only", "Thanksgiving Break"]

// A day's spans in quarter hours, the second, if any, after the first ends, and either running past midnight
const daySpans: fc.Arbitrary<Span[]> = fc.oneof(
  fc.constant<Span[]>([]),
  fc.tuple(fc.integer({ min: 0, max: 95 }), fc.integer({ min: 1, max: 96 }))
    .map(([open, length]): Span[] => [[open * 15, (open + length) * 15]]),
  fc.uniqueArray(fc.integer({ min: 0, max: 191 }), { minLength: 4, maxLength: 4 })
    .map(points => points.toSorted((a, b) => a - b).map(point => point * 15))
    .filter(([a, b, c, d]) => b - a <= DAY && c < DAY && d - c <= DAY)
    .map(([a, b, c, d]): Span[] => [[a, b], [c, d]])
)

const week = fc.array(daySpans, { minLength: 7, maxLength: 7 })

/** Like "7:15 am" or "12:00 pm", on the wall clock, so past midnight comes out as the next morning */
const clock = (minutes: number) => {
  const hour = Math.floor(minutes % DAY / 60)
  return `${hour % 12 || 12}:${`${minutes % 60}`.padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`
}

/** The Hours block as Drupal's office hours writes it, from some first day, with runs of the same hours as one range */
const unhPage = (days: UnhDay[], first: number) => {
  const order = Array.from({ length: 7 }, (_, i) => (first + i) % 7)
  const groups: number[][] = []
  for (const day of order) {
    const last = groups.at(-1)
    if (last && JSON.stringify(days[last.at(-1)!]) === JSON.stringify(days[day]))
      last.push(day)
    else
      groups.push([day])
  }

  const items = groups.map(group => {
    const { spans, note } = days[group[0]]
    const label = group.length > 1 ? `${LABELS[group[0]]} - ${LABELS[group.at(-1)!]}` : LABELS[group[0]]
    const slots = spans.map(([open, close]) =>
      `<div class="office-hours__item-slot"><div class="office-hours__item-hours">${clock(open)}-${clock(close)}</div></div>`
    )
    if (!spans.length)
      slots.push(`<div class="office-hours__item-slot"><div class="office-hours__item-comment">Closed</div></div>`)
    if (note)
      slots.push(`<div class="office-hours__item-comment">${note.replace("&", "&amp;")}</div>`)
    return `<div class="office-hours__item">
      <div class="office-hours__item-label" style="width: 6.05em;">${label}: </div>
      <div class="office-hours__item-slots">${slots.join("\n")}</div>
    </div>`
  })
  return `<h2>Hours of Operation</h2><p>Hours may vary.</p><h2>Hours</h2>
    <div class="office-hours-status office-hours-status--open">Currently open!</div>
    <div class="office-hours">${items.join("\n")}</div>
    <div class="h4">Accessible features</div>`
}

const unhWeek = fc.array(
  fc.record({ spans: daySpans, note: fc.option(fc.constantFrom(...NOTES), { nil: undefined }) })
    .map(({ spans, note }): UnhDay => note ? { spans, note } : { spans }),
  { minLength: 7, maxLength: 7 }
)

test("a hall's week written out as UNH's page writes it, from any first day, parses back to it", () =>
  fc.assert(fc.property(unhWeek, fc.integer({ min: 0, max: 6 }), (days, first) => {
    expect(parseUnhHours(unhPage(days, first))).toEqual(days)
  }))
)

test("a page that leaves out a day, or names one twice, has no week", () =>
  fc.assert(fc.property(unhWeek, fc.integer({ min: 0, max: 6 }), (days, first) => {
    const page = unhPage(days, first)
    const items = page.split(`<div class="office-hours__item">`)
    expect(parseUnhHours(items.slice(0, -1).join(`<div class="office-hours__item">`) + "</div>")).toBeUndefined()
    expect(parseUnhHours(page + page)).toBeUndefined()
  }))
)

test("parsing never throws on any page", () =>
  fc.assert(fc.property(fc.string(), text => {
    parseUnhHours(text)
    parseUnhHours(`<div class="office-hours__item-label">${text}</div><div class="office-hours__item-hours">${text}</div>`)
  }))
)

test("the halls' pages as UNH writes them", () => {
  const item = (label: string, part: string) =>
    `<div class="office-hours__item"><div class="office-hours__item-label" style="width: 6.05em;">${label}: </div>` +
    `<div class="office-hours__item-slots"><div class="office-hours__item-slot office-hours__item-full">${part}</div></div></div>`
  const hours = (text: string) => `<div class="office-hours__item-hours">${text}</div>`
  const comment = (text: string) => `<div class="office-hours__item-comment">${text}</div>`

  expect(parseUnhHours(item("Sun", hours("8:00 am-9:00 pm")) + item("Mon - Fri", hours("7:15 am-9:00 pm")) + item("Sat", hours("8:00 am-9:00 pm"))))
    .toEqual([480, 435, 435, 435, 435, 435, 480].map(open => ({ spans: [[open, 1260]] })))
  expect(parseUnhHours(
    item("Sun", comment("Closed")) +
    item("Mon - Wed", hours("7:15 am-9:00 pm")) +
    item("Thu", hours("7:15 am-2:00 pm") + comment("Early Close - U-Day")) +
    item("Fri", hours("7:15 am-9:00 pm")) +
    item("Sat", comment("Closed"))
  )).toEqual([
    { spans: [] },
    { spans: [[435, 1260]] },
    { spans: [[435, 1260]] },
    { spans: [[435, 1260]] },
    { spans: [[435, 840]], note: "Early Close - U-Day" },
    { spans: [[435, 1260]] },
    { spans: [] }
  ])
  expect(parseUnhHours(item("Sun - Sat", hours("11:00 am-12:00 am")))).toEqual(Array(7).fill({ spans: [[660, 1440]] }))
})

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const

test("a Nutrislice school's week, with closing at or before opening the next morning, reads back", () =>
  fc.assert(fc.property(fc.array(fc.oneof(fc.constant([]), daySpans.filter(spans => spans.length === 1)), { minLength: 7, maxLength: 7 }), days => {
    const time = (minutes: number) => `${`${Math.floor(minutes % DAY / 60)}`.padStart(2, "0")}:${`${minutes % 60}`.padStart(2, "0")}:00`
    const school: NutrisliceSchool = {}
    WEEKDAYS.forEach((day, i) => {
      const [open, close] = days[i][0] ?? [660, 840]
      Object.assign(school, { [`${day}_enabled`]: !!days[i].length, [`${day}_is_24_hours`]: false, [`${day}_start`]: time(open), [`${day}_end`]: time(close) })
    })
    expect(nutrisliceHours(school)).toEqual(days)
  }))
)

test("Nutrislice's hours as it sends them, with Philbrook's weekend turned off", () => {
  const school: NutrisliceSchool = Object.fromEntries(WEEKDAYS.flatMap(day => [
    [`${day}_enabled`, day !== "sat" && day !== "sun"],
    [`${day}_is_24_hours`, false],
    [`${day}_start`, day === "sat" || day === "sun" ? "11:00:00" : "07:15:00"],
    [`${day}_end`, day === "sun" ? "02:00:00" : day === "sat" ? "14:00:00" : "21:00:00"]
  ]))
  expect(nutrisliceHours(school)).toEqual([[], ...Array(5).fill([[435, 1260]]), []])
  expect(nutrisliceHours({ ...school, sun_enabled: true })?.[0]).toEqual([[660, 1560]])
  expect(nutrisliceHours({ ...school, mon_is_24_hours: true })?.[1]).toEqual([[0, 1440]])
  expect(nutrisliceHours({ ...school, mon_start: null })).toBeUndefined()
})

test("a day UNH notes is a one-off for its date this week, with Nutrislice's hours that weekday the rest of the time", () => {
  const usual: Span[][] = [[], ...Array(5).fill([[435, 1260]]), []]
  const unh: UnhDay[] = usual.map(spans => ({ spans }))
  unh[4] = { spans: [[435, 840]], note: "Early Close - U-Day" }

  // 2026-09-29 is a Tuesday, so that week's Thursday is October 1st
  expect(hallHours(unh, usual, "2026-09-29")).toEqual({ week: usual, special: { "2026-10-01": { spans: [[435, 840]], note: "Early Close - U-Day" } } })
  expect(hallHours(unh, usual, "2026-10-02")).toEqual({ week: usual })
  expect(hallHours(unh, undefined, "2026-10-02")?.week[4]).toEqual([[435, 840]])
  expect(hallHours(undefined, usual, "2026-10-02")).toEqual({ week: usual })
  expect(hallHours(undefined, undefined, "2026-10-02")).toBeUndefined()
})

const DATES = Array.from({ length: 14 }, (_, i) => addDays("2026-10-01", i))

const hours: fc.Arbitrary<Hours> = fc.tuple(week, fc.option(fc.tuple(fc.constantFrom(...DATES), daySpans), { nil: undefined }))
  .map(([week, special]) => special ? { week, special: { [special[0]]: { spans: special[1], note: "Special" } } } : { week })

// As often as not right when the hall opens or closes, where an off-by-one would be
const hoursAndNow = fc.tuple(hours, fc.constantFrom(...DATES.slice(1, 7)), fc.integer({ min: 0, max: DAY - 1 }))
  .chain(([hours, date, minute]) => {
    const edges = [-1, 0]
      .flatMap(offset => spansOn(hours, addDays(date, offset)).flat().map(edge => edge + offset * DAY))
      .filter(edge => edge >= 0 && edge < DAY)
    return fc.oneof(fc.constant(minute), fc.constantFrom(minute, ...edges))
      .map(minute => [hours, { date, minute }] as const)
  })

/** Minutes from now's midnight */
const minutesFrom = (now: WallTime, { date, minute }: WallTime) =>
  (Date.parse(date) - Date.parse(now.date)) / 60_000 + minute

/** Whether any day's span, yesterday's included, covers a minute from now's midnight, the slow way */
const isOpenAt = (hours: Hours, now: WallTime, minute: number) =>
  [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8].some(offset =>
    spansOn(hours, addDays(now.date, offset)).some(([open, close]) => open + offset * DAY <= minute && minute < close + offset * DAY)
  )

test("a hall is open until it closes, and closed until it opens, or for a week when it doesn't", () =>
  fc.assert(fc.property(hoursAndNow, ([hours, now]) => {
    const found = status(hours, now)
    const until = found.isOpen ? minutesFrom(now, found.closes) : found.opens ? minutesFrom(now, found.opens) : now.minute + 7 * DAY
    expect(until).toBeGreaterThan(now.minute)
    for (let minute = now.minute; minute < until; minute++)
      expect(isOpenAt(hours, now, minute)).toBe(found.isOpen)
    // A hall open all week closes, as far as a week's hours say, at the end of them
    if ((found.isOpen || found.opens) && until < 7 * DAY)
      expect(isOpenAt(hours, now, until)).toBe(!found.isOpen)
  }))
)

test("Philbrook on a Friday night, and a hall open past midnight", () => {
  const philbrook: Hours = { week: [[], ...Array(5).fill([[435, 1260]]), []] }
  // 2026-10-02 is a Friday
  expect(status(philbrook, { date: "2026-10-02", minute: 20 * 60 })).toEqual({ isOpen: true, closes: { date: "2026-10-02", minute: 1260 } })
  expect(status(philbrook, { date: "2026-10-02", minute: 21 * 60 })).toEqual({ isOpen: false, opens: { date: "2026-10-05", minute: 435 } })
  expect(status(philbrook, { date: "2026-10-03", minute: 0 })).toEqual({ isOpen: false, opens: { date: "2026-10-05", minute: 435 } })

  const late: Hours = { week: [[[660, 1560]], [[435, 1260]], [], [], [], [], []] }
  expect(status(late, { date: "2026-10-05", minute: 60 })).toEqual({ isOpen: true, closes: { date: "2026-10-05", minute: 120 } })
  expect(status(late, { date: "2026-10-05", minute: 120 })).toEqual({ isOpen: false, opens: { date: "2026-10-05", minute: 435 } })
  // Open to midnight then from midnight is open straight through
  expect(status({ week: [[[1200, 1440]], [[0, 600]], [], [], [], [], []] }, { date: "2026-10-04", minute: 1300 }))
    .toEqual({ isOpen: true, closes: { date: "2026-10-05", minute: 600 } })
  expect(status({ week: Array(7).fill([]) }, { date: "2026-10-05", minute: 0 })).toEqual({ isOpen: false })
})
