// The one rule for data that outlives its code (src/shared/format.mts), over formats of any version reading data of
// any other: older data comes up through every upgrade since, in order, newer data is told apart and left exactly as it
// is, and everything else reads as nothing there

import { test, expect } from "vitest"
import fc from "fast-check"
import * as v from "valibot"
import { type Format, format, read, readKept, versionOf } from "../../src/shared/format.mts"
import { checked, isNewerFormat } from "../../src/shared/json.mts"

/** A toy's data at a version: its items, bare at 0 as data was before formats, else with every version it's been through */
type Toy = { version: number, items: string[], through: number[] }

const written = (version: number, items: string[]): unknown =>
  version ? { version, items, through: Array.from({ length: version }, (_, i) => i + 1) } : items

/** The toy's format as code of a version has it, reading back to the oldest it still upgrades */
const toyOf = (version: number, oldest: number): Format<Toy> => {
  const Schema = v.object({ version: v.literal(version), items: v.array(v.string()), through: v.array(v.number()) })
  const upgrades = Array.from({ length: version - oldest }, (_, i) => (older: unknown): unknown => {
    const from = oldest + i
    // Each upgrade is given the version before its own, and nothing else
    expect(versionOf(older)).toBe(from)
    const { items, through }: { items: string[], through: number[] } = from ? Object(older) : { items: older, through: [] }
    return { version: from + 1, items, through: [...through, from + 1] }
  })
  return version ? format(Schema as v.GenericSchema<unknown, Toy>, version, ...upgrades) : format(items => ({ version: 0, items: v.parse(v.array(v.string()), items), through: [] }))
}

const versions = fc.tuple(fc.nat(5), fc.nat(5), fc.nat(5)).map(([a, b, c]) => {
  const [oldest, version] = [a, b].sort((x, y) => x - y)
  return { oldest, version, said: c }
})
const items = fc.array(fc.string(), { maxLength: 4 })

test("data says its version as a whole number above 0, and anything else is version 0", () =>
  fc.assert(fc.property(fc.anything(), fc.oneof(fc.integer(), fc.double(), fc.string(), fc.constant(undefined)), (data, version) => {
    expect(versionOf(data)).toBe(Number.isSafeInteger(Object(data).version) && Object(data).version > 0 ? Object(data).version : 0)
    expect(versionOf({ version })).toBe(typeof version === "number" && Number.isSafeInteger(version) && version > 0 ? version : 0)
    expect(versionOf([version])).toBe(0)
  }))
)

test("code of any version reads data of any other: older through every upgrade since, in order, newer as newer, and older than it upgrades as nothing", () =>
  fc.assert(fc.property(versions, items, ({ oldest, version, said }, items) => {
    const toy = toyOf(version, oldest)
    const data = written(said, items)
    const before = structuredClone(data)
    const found = read(toy, data)
    if (said > version)
      expect(found).toEqual({ newer: said })
    else if (said < oldest)
      expect(found).toEqual({ issues: [{ message: expect.stringContaining(`Version ${said} is older than ${oldest}`) }] })
    else
      // What code of this version would have written itself, whichever version wrote it
      expect(found).toEqual({ value: version ? written(version, items) : { version: 0, items, through: [] } })
    // Reading changes nothing of what's read
    expect(data).toEqual(before)
  }))
)

test("upgrading through versions one release at a time gives what upgrading at once does", () =>
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 5 }), items, (steps, items) => {
    const through = steps.map((_, i) => steps.slice(0, i + 1).reduce((sum, step) => sum + step, 0))
    const last = through.at(-1)!
    let data = written(0, items)
    for (const version of through) {
      const found = read(toyOf(version, 0), data)
      data = "value" in found ? found.value : undefined
    }
    expect(data).toEqual(written(last, items))
    expect(read(toyOf(last, 0), written(0, items))).toEqual({ value: data })
  }))
)

test("data of a version that isn't what its schema says, or that an upgrade can't make sense of, reads as issues, never as a value", () =>
  fc.assert(fc.property(versions.filter(({ oldest, version, said }) => said >= oldest && said <= version && version > 0), fc.jsonValue(), ({ oldest, version, said }, junk) => {
    const found = read(toyOf(version, oldest), said ? { version: said, items: junk, through: "x" } : { not: junk })
    expect("issues" in found && found.issues.length > 0).toBe(true)
  }))
)

test("what's kept reads as nothing kept where newer code wrote it or it can't be read, by a format that reads anything", () =>
  fc.assert(fc.property(fc.nat(4), fc.nat(4), fc.oneof(items, fc.jsonValue()), (version, said, kept) => {
    const toy = toyOf(version, 0)
    const lenient: Format<Toy> = version
      ? { ...toy, upgrades: [(older: unknown) => toy.upgrades[0](Array.isArray(older) && older.every(item => typeof item === "string") ? older : []), ...toy.upgrades.slice(1)] }
      : format(found => ({ version: 0, items: Array.isArray(found) && found.every(item => typeof item === "string") ? found : [], through: [] }))
    const data = Array.isArray(kept) && kept.every(item => typeof item === "string") ? written(said, kept as string[]) : kept
    const found = read(lenient, data)
    expect(readKept(lenient, data)).toEqual("value" in found ? found.value : readKept(lenient, null))
    if (versionOf(data) > version)
      expect(readKept(lenient, data).items).toEqual([])
  }))
)

test("a format has no more upgrades than versions before it, and JSON checked by one fails apart for a newer version", async () => {
  expect(() => format(v.object({ version: v.literal(1) }), 1, x => x, x => x)).toThrow(RangeError)
  expect(() => format(v.string(), 0, x => x)).toThrow(RangeError)
  const toy = toyOf(2, 1)
  await expect(checked(toy, written(1, ["a"]), "/toy.json")).resolves.toEqual(written(2, ["a"]))
  const newer = await checked(toy, written(3, ["a"]), "/toy.json").catch(error => error)
  expect(isNewerFormat(newer)).toBe(true)
  expect(`${newer}`).toContain("/toy.json is of version 3, newer than this reads")
  const unfit = await checked(toy, written(0, ["a"]), "/toy.json").catch(error => error)
  expect(isNewerFormat(unfit)).toBe(false)
  expect(`${unfit}`).toContain("Unexpected JSON from /toy.json: Version 0 is older than 1")
})
