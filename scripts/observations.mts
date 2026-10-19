// How the build and scripts read what the Worker observed on a service day: from the day's archive once the catalog
// lists it (src/map/archive.mts), checked against the catalog's hash, or else from the Worker's D1, which keeps a
// day's samples until it's archived, decoded either way to the same rows (src/map/raw.mts), so extraction runs on
// either. Only reads

import { gunzipSync } from "node:zlib"
import { decode, fromHex, observe, type ObservedRow, type Source } from "../src/map/raw.mts"
import { archiveUrl, fetchCatalog, type Catalog, type Manifest } from "../src/map/archive.mts"
import { serviceDayStart } from "../src/map/feed.mts"
import { type Day, addDays, localDay } from "../src/shared/time.mts"
import { sha256 } from "./map/release.mts"
import { readRows } from "./worker.mts"

export const SOURCES: Source[] = ["buses", "predictions"]

// Samples still arrive this long after a service day ends
const SETTLE_MS = 15 * 60_000

/** The last service day all of whose samples have arrived at an instant */
export const lastSettled = (now: number): Day => {
  const today = localDay(now)
  return addDays(today, serviceDayStart(today) + SETTLE_MS <= now ? -1 : -2)
}

/** Rows in the order of their minutes, buses before predictions, as an archive keeps them */
export const byMinute = (a: ObservedRow, b: ObservedRow) =>
  a.at - b.at || a.source.localeCompare(b.source)

/** A row as the Worker stores it, decoded, or else an error saying which it was, or with skip, a warning and nothing */
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
 * A day's rows of both sources as the Worker stores them, decoded, failing on any this can't read rather than leave
 * it out, or with skip, leaving it out, so one bad row costs its minute rather than the day
 */
export const storedRows = async (day: Day, skip = false) =>
  (await Promise.all(SOURCES.map(async source =>
    Promise.all((await readRows<{ at: number, body: string }>(source, day)).map(row => decoded(source, row, skip)))
  ))).flat(2)

/** The rows an archive holds, a line each */
export const unpack = (bytes: Uint8Array) =>
  gunzipSync(bytes).toString().split("\n").filter(Boolean).map(line => JSON.parse(line) as ObservedRow)

/** An archived day's rows, as long as its file is exactly what its manifest says */
export const archivedRows = async ({ day, sha256: hash, bytes }: Manifest, load = fetch) => {
  const url = archiveUrl(day)
  const response = await load(url)
  if (!response.ok)
    throw new Error(`${response.status} from ${url}`)
  const file = new Uint8Array(await response.arrayBuffer())
  if (file.length !== bytes || sha256(file) !== hash)
    throw new Error(`${url} isn't the file its manifest names`)
  return unpack(file)
}

// Read once, when first a day is
let catalog: Promise<Catalog> | undefined

/** A day's rows, from its archive if it has one, else from the Worker, without any row it can't read */
export const rowsOf = async (day: Day) => {
  const manifest = (await (catalog ??= fetchCatalog())).days.find(manifest => manifest.day === day)
  return manifest ? archivedRows(manifest) : storedRows(day, true)
}

/** Everything observed on a service day, and when each source was looking */
export const observationsOf = async (day: Day) =>
  observe(await rowsOf(day))
