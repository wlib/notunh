import { test, expect, vi, afterEach } from "vitest"
import fc from "fast-check"
import { Readable } from "node:stream"
import { type ObservedRow, RAW_VERSION } from "../../src/transit/observations/raw.mts"
import { CATALOG, type Manifest, archiveUrl, fetchCatalog, fileOf } from "../../src/transit/observations/archive.mts"
import { gzipSync } from "node:zlib"
import { serviceDayStart } from "../../src/transit/feed.mts"
import { addDays, daysBetween } from "../../src/shared/time.mts"
import { catalogWith, daysToArchive, manifestOf, pack } from "../../scripts/archive.mts"
import { archivedRows, byMinute, lastSettled, unpack } from "../../scripts/observations.mts"

afterEach(() => {
  vi.unstubAllGlobals()
})

const DAY = "2026-10-14"
const START = serviceDayStart(DAY)

const id = fc.stringMatching(/^[A-Za-z0-9 _"\\-]{1,8}$/)
const seconds = fc.double({ min: -120, max: 120, noNaN: true })
const nullable = <T,>(arbitrary: fc.Arbitrary<T>) => fc.option(arbitrary, { nil: null })
const polls = nullable(fc.array(fc.tuple(seconds, nullable(fc.nat(20))), { minLength: 1, maxLength: 6 }))

/** A day's rows, any version, each source at most once a minute, as decoded from the JSON the Worker stores, which has no -0 */
const rows = fc.uniqueArray(
  fc.oneof(
    fc.record({
      source:  fc.constant("buses" as const),
      at:      fc.nat(1439).map(minute => START + minute * 60_000),
      version: fc.constantFrom(0 as const, 1 as const, RAW_VERSION),
      samples: fc.array(fc.tuple(id, seconds, fc.double({ noNaN: true, noDefaultInfinity: true }), fc.double({ noNaN: true, noDefaultInfinity: true }), nullable(fc.nat(359)), nullable(fc.nat(100)), nullable(id), nullable(id), nullable(id), fc.nat(5)), { maxLength: 5 }),
      polls
    }),
    fc.record({
      source:  fc.constant("predictions" as const),
      at:      fc.nat(287).map(slot => START + slot * 300_000),
      version: fc.constantFrom(0 as const, 1 as const, RAW_VERSION),
      samples: fc.array(fc.tuple(id, id, id, nullable(id), seconds, fc.constantFrom(0 as const, 1 as const)), { maxLength: 5 }),
      polls
    })
  ) as fc.Arbitrary<ObservedRow>,
  { selector: ({ source, at }) => `${source} ${at}` }
).map(rows => JSON.parse(JSON.stringify(rows)) as ObservedRow[])

test("an archive reads back as exactly the rows it was packed from, in the order of their minutes, and packs to the same bytes again", () =>
  fc.assert(fc.asyncProperty(rows, async rows => {
    const file = await pack(rows)
    expect(await unpack(fileOf(DAY), Readable.from([file]))).toEqual(rows.toSorted(byMinute))
    expect(await pack(rows.toReversed())).toEqual(file)
  }))
)

test("a manifest counts each source's rows, samples, versions, and polls, and names the file by its hash and size", () =>
  fc.assert(fc.asyncProperty(rows, async rows => {
    const file = await pack(rows)
    const { day, file: name, bytes, sha256, sources } = await manifestOf(DAY, rows, file)
    expect([day, name, bytes, sha256]).toEqual([DAY, fileOf(DAY), file.length, expect.stringMatching(/^[0-9a-f]{64}$/)])
    for (const source of ["buses", "predictions"] as const) {
      const of = rows.filter(row => row.source === source)
      const all = of.flatMap(row => row.polls ?? [])
      expect(sources[source]).toEqual({
        rows:     of.length,
        samples:  of.reduce((sum, row) => sum + row.samples.length, 0),
        versions: [...new Set(of.map(row => row.version))].sort(),
        polls:    all.length,
        failed:   all.filter(([, seen]) => seen === null).length
      })
    }
  }))
)

const manifest = (day: string, sha256 = "0".repeat(64)): Manifest => {
  const counts = { rows: 1, samples: 1, versions: [RAW_VERSION], polls: 1, failed: 0 }
  return { day, sha256, bytes: 1, sources: { buses: counts, predictions: counts } }
}

test("merging manifests into the catalog keeps one per day, the latest merged, in order of day", () =>
  fc.assert(fc.property(fc.array(fc.nat(30)), fc.array(fc.nat(30)), (before, merged) => {
    const days = (offsets: number[], hash: string) => offsets.map(offset => manifest(addDays(DAY, offset), hash.repeat(64)))
    const catalog = catalogWith({ days: days(before, "a") }, days(merged, "b"))
    expect(catalog.days.map(({ day }) => day)).toEqual([...new Set([...before, ...merged])].sort((a, b) => a - b).map(offset => addDays(DAY, offset)))
    for (const { day, sha256 } of catalog.days)
      expect(sha256[0]).toBe(merged.some(offset => addDays(DAY, offset) === day) ? "b" : "a")
  }))
)

test("the days to archive are those asked for that have settled, by default the last week settled", () =>
  fc.assert(fc.property(fc.integer({ min: Date.parse("2026-01-01"), max: Date.parse("2027-12-31") }), fc.integer({ min: -20, max: 5 }), fc.nat(10), (now, start, length) => {
    const last = lastSettled(now)
    expect(serviceDayStart(addDays(last, 1)) + 15 * 60_000).toBeLessThanOrEqual(now)
    expect(serviceDayStart(addDays(last, 2)) + 15 * 60_000).toBeGreaterThan(now)
    const byDefault = daysToArchive(now)
    expect(byDefault).toHaveLength(7)
    expect(byDefault.at(-1)).toBe(last)
    const [from, to] = [addDays(last, start), addDays(last, start + length)]
    const days = daysToArchive(now, from, to)
    expect(days).toEqual(Array.from({ length: Math.max(0, daysBetween(from, to < last ? to : last) + 1) }, (_, i) => addDays(from, i)))
    expect(daysToArchive(now, from)).toEqual(from <= last ? [from] : [])
  }))
)

test("an archived day is read only when its file is exactly what its manifest names, gzipped as it was before 2026-10-20 or zstd's", async () => {
  const rows: ObservedRow[] = [{ source: "buses", at: START, version: RAW_VERSION, samples: [], polls: [[0.5, 0]] }]
  const file = await pack(rows)
  const named = await manifestOf(DAY, rows, file)
  const urls: string[] = []
  const serve = (body: Uint8Array, status = 200) => async (url: string | URL | Request) => {
    urls.push(`${url}`)
    return new Response(status === 200 ? body.slice() : null, { status })
  }
  expect(await archivedRows(named, serve(file))).toEqual(rows)
  expect(urls).toEqual([archiveUrl(named)])
  expect(urls[0]).toMatch(/\.ndjson\.zst$/)
  await expect(archivedRows({ ...named, sha256: "f".repeat(64) }, serve(file))).rejects.toThrow("isn't the file")
  await expect(archivedRows({ ...named, bytes: named.bytes + 1 }, serve(file))).rejects.toThrow("isn't the file")
  await expect(archivedRows(named, serve(file, 404))).rejects.toThrow("404")
  // A day archived before manifests named their file is the gzipped one
  const gzipped = gzipSync(`${JSON.stringify(rows[0])}\n`)
  const { file: _, ...older } = await manifestOf(DAY, rows, gzipped)
  expect(await archivedRows(older, serve(gzipped))).toEqual(rows)
  expect(urls.at(-1)).toMatch(/\.ndjson\.gz$/)
  await expect(archivedRows({ ...older, file: named.file }, serve(gzipped))).rejects.toThrow("isn't the file")
})

test("the catalog is empty while there's none, and anything else wrong with it fails", async () => {
  vi.stubGlobal("fetch", async () => new Response("", { status: 404 }))
  expect(await fetchCatalog()).toEqual({ days: [] })
  vi.stubGlobal("fetch", async () => new Response("", { status: 502 }))
  await expect(fetchCatalog()).rejects.toThrow("502")
  vi.stubGlobal("fetch", async () => Response.json({ days: [{ day: "Sunday" }] }))
  await expect(fetchCatalog()).rejects.toThrow(CATALOG)
  vi.stubGlobal("fetch", async () => Response.json({ days: [manifest(DAY)] }))
  expect(await fetchCatalog()).toEqual({ days: [manifest(DAY)] })
})
