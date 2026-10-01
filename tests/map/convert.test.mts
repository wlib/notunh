import { test, expect } from "vitest"
import fc from "fast-check"
import { ColorSpace, contrastWCAG21, parse, sRGB } from "colorjs.io/fn"
import { interpolateTimes, parseTable, readableText } from "../../scripts/map/convert.mts"

ColorSpace.register(sRGB)

test("parseTable reads GTFS's quirks: a byte order mark, quoted fields, padding, and blank rows", () => {
  const text = "\uFEFFroute_id, route_long_name ,route_color\r\n1,\"Dover, NH\",FF6600\r\n,,\r\n2,\"Say \"\"hi\"\"\",\r\n"
  expect(parseTable(text)).toEqual([
    { route_id: "1", route_long_name: "Dover, NH", route_color: "FF6600" },
    { route_id: "2", route_long_name: "Say \"hi\"", route_color: "" }
  ])
})

const knownTimes = fc
  .array(fc.option(fc.nat({ max: 600 }), { nil: undefined }), { minLength: 1, maxLength: 20 })
  .chain(steps =>
    fc.tuple(
      fc.constant(steps),
      fc.array(fc.nat({ max: 2000 }), { minLength: steps.length, maxLength: steps.length })
    )
  )
  .map(([steps, gaps]) => {
    // Running sums so known times and distances only ever increase
    let time = 0
    let along = 0
    return {
      known: steps.map(step => step === undefined ? undefined : time += step),
      along: gaps.map((gap, i) => i === 0 ? 0 : along += gap)
    }
  })

test("interpolateTimes keeps known times and fills the rest in order", () =>
  fc.assert(fc.property(knownTimes, ({ known, along }) => {
    const times = interpolateTimes(known, along)

    expect(times).toHaveLength(known.length)
    known.forEach((time, i) => {
      if (time !== undefined)
        expect(times[i]).toBe(time)
    })
    if (known.some(time => time !== undefined))
      for (let i = 1; i < times.length; i++)
        expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
  }))
)

test("interpolateTimes is proportional to distance between timepoints", () => {
  expect(interpolateTimes([0, undefined, undefined, 300], [0, 100, 300, 300])).toEqual([0, 100, 300, 300])
  expect(interpolateTimes([undefined, 60, undefined], [0, 0, 50])).toEqual([60, 60, 60])
})

const hex = fc.integer({ min: 0, max: 0xFFFFFF }).map(n => "#" + n.toString(16).padStart(6, "0"))

test("readableText keeps a readable GTFS color, otherwise picks whichever of black and white reads better", () =>
  fc.assert(fc.property(hex, hex, (color, text) => {
    const contrast = (foreground: string) => contrastWCAG21(parse(color), parse(foreground))
    const chosen = readableText(color, text)
    if (contrast(text) >= 4.5)
      expect(chosen).toBe(text)
    else
      expect(contrast(chosen)).toBe(Math.max(contrast("#000000"), contrast("#ffffff")))
  }))
)
