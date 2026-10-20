// How the build and scripts read what the Worker observed on a service day. Once the catalog lists the day, it's read
// from the archive (src/transit/observations/archive.mts) and checked against the manifest's hash as it streams.
// Otherwise it's read from the Worker's D1, which keeps a day's samples until it's archived. Either way it decodes to
// the same rows (src/transit/observations/raw.mts), so extraction runs on either, and they have the same id. Only
// reads

import { createInterface } from "node:readline"
import { Readable } from "node:stream"
import { createZstdDecompress } from "node:zlib"
import { decode, fromHex, observe, type ObservedRow, type Source } from "../src/transit/observations/raw.mts"
import { archiveUrl, fetchCatalog, type Catalog, type Manifest } from "../src/transit/observations/archive.mts"
import { serviceDayStart } from "../src/transit/feed.mts"
import { type Day, addDays, localDay } from "../src/shared/time.mts"
import { contentHash } from "../src/shared/hash.mts"
import { readRows } from "./worker.mts"

export const SOURCES: Source[] = ["buses", "predictions"]

// Samples still arrive this long after a service day ends
const SETTLE_MS = 15 * 60_000

/** The last service day all of whose samples have arrived at an instant */
export const lastSettled = (now: number): Day => {
  // Service days start at noon less 12 hours, so the day after the clocks spring forward starts the evening before
  let day = addDays(localDay(now), 1)
  while (serviceDayStart(addDays(day, 1)) + SETTLE_MS > now)
    day = addDays(day, -1)
  return day
}

/** Rows in the order of their minutes, buses before predictions, as an archive keeps them */
export const byMinute = (a: ObservedRow, b: ObservedRow) =>
  a.at - b.at || a.source.localeCompare(b.source)

/** Rows as an archive's lines, in the order of their minutes */
export const linesOf = (rows: readonly ObservedRow[]) =>
  rows.toSorted(byMinute).map(row => `${JSON.stringify(row)}\n`)

/** A row as the Worker stores it, decoded. One that can't be decoded throws, or with skip, warns and gives nothing */
const decoded = async (source: Source, { at, body }: { at: number, body: string }, skip: boolean): Promise<ObservedRow[]> => {
  try {
    return [{ source, at, ...await decode(fromHex(body)) } as ObservedRow]
  }
  catch (error) {
    const message = `the ${source} of ${new Date(at).toISOString()}: ${error instanceof Error ? error.message : error}`
    if (!skip)
      throw new Error(`Can't read ${message}`)
    console.warn(`Skipped ${message}`)
    return []
  }
}

/**
 * A day's rows of both sources as the Worker stores them, decoded. Fails on any row it can't read, or with skip,
 * leaves it out, so one bad row costs its minute rather than the day
 */
export const storedRows = async (day: Day, skip = false) =>
  (await Promise.all(SOURCES.map(async source =>
    Promise.all((await readRows<{ at: number, body: string }>(source, day)).map(row => decoded(source, row, skip)))
  ))).flat(2)

/** The rows an archive holds, a line each, as its file's zstd bytes come */
export const unpack = async (bytes: AsyncIterable<Uint8Array>) => {
  const lines = createInterface({ input: Readable.from(bytes).pipe(createZstdDecompress()), crlfDelay: Infinity })
  const rows: ObservedRow[] = []
  for await (const line of lines)
    if (line)
      rows.push(JSON.parse(line))
  return rows
}

/** An archived day's rows, as long as its file is exactly what its manifest says, hashed as it's read */
export const archivedRows = async (manifest: Manifest, load = fetch) => {
  const url = archiveUrl(manifest)
  const response = await load(url)
  if (!response.ok || !response.body)
    throw new Error(`${response.status} from ${url}`)
  let bytes = 0
  const [hashing, reading] = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform: (chunk, out) => {
      bytes += chunk.length
      out.enqueue(chunk)
    }
  })).tee()
  const [hash, rows] = await Promise.all([contentHash(hashing), unpack(reading).catch(() => undefined)])
  if (bytes !== manifest.bytes || hash !== manifest.sha256 || !rows)
    throw new Error(`${url} isn't the file its manifest names`)
  return rows
}

// Fetched once, when the first day is read
let catalog: Promise<Catalog> | undefined

/** A day's rows, from its archive if it has one, else from the Worker, without any row it can't read */
export const rowsOf = async (day: Day) => {
  const manifest = (await (catalog ??= fetchCatalog())).days.find(manifest => manifest.day === day)
  return manifest ? archivedRows(manifest) : storedRows(day, true)
}

/**
 * Everything observed on a service day, when each source was looking, and its id: the SHA-256 of its rows as an
 * archive's lines, the same whether read from the archive or the Worker
 */
export const observationsOf = async (day: Day) => {
  const rows = await rowsOf(day)
  return { ...observe(rows), id: await contentHash(linesOf(rows).join("")) }
}
