// Archives what the Worker observed on completed service days, for the Observations workflow
// (.github/workflows/archive.yml) to publish in the format src/transit/observations/archive.mts describes. A day is its
// stored rows, decoded, as one zstd-compressed ndjson file with a manifest. Packing is deterministic, so the same rows
// make the same bytes. zstd at level 19 with long-distance matching suits a day's minutes, which repeat each other
// over hours: a weekday's file is 23 % smaller than with gzip -9 (640 KB to 490 KB, measured on Oct 8 to 18 2026).
// Only scripts read the archive, so no page or Worker needs zstd (they have only gzip). Reads the Worker with
// BUILD_TOKEN and writes only files:
//   node scripts/archive.mts days [from [to]]                  the settled days of a range the catalog doesn't have,
//                                                              by default every one the Worker still has samples of
//   node scripts/archive.mts pack <day> <folder>               the day's file and manifest.json, if it has any rows
//   node scripts/archive.mts catalog <catalog.json> <manifest.json>…   the catalog with the manifests merged in

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { Readable } from "node:stream"
import { constants, createZstdCompress } from "node:zlib"
import * as v from "valibot"
import type { ObservedRow } from "../src/transit/observations/raw.mts"
import { Catalog, Manifest, fetchCatalog, fileOf } from "../src/transit/observations/archive.mts"
import { Day, addDays, localDay } from "../src/shared/time.mts"
import { checked } from "../src/shared/json.mts"
import { contentHash } from "../src/shared/hash.mts"
import { SOURCES, byMinute, lastSettled, linesOf, storedRows, unpack } from "./observations.mts"
import { health } from "./worker.mts"

const ZSTD = { params: { [constants.ZSTD_c_compressionLevel]: 19, [constants.ZSTD_c_enableLongDistanceMatching]: 1 } }

/** Rows as ndjson in the order of their minutes, compressed as they're written */
export const pack = async (rows: readonly ObservedRow[]) =>
  new Uint8Array(Buffer.concat(await Array.fromAsync(Readable.from(linesOf(rows)).pipe(createZstdCompress(ZSTD)))))

export const manifestOf = async (day: Day, rows: readonly ObservedRow[], file: Uint8Array): Promise<Manifest> => {
  const counts = (source: ObservedRow["source"]) => {
    const of = rows.filter(row => row.source === source)
    const polls = of.flatMap(row => row.polls ?? [])
    return {
      rows:     of.length,
      samples:  of.reduce((sum, row) => sum + row.samples.length, 0),
      versions: [...new Set(of.map(row => row.version))].sort(),
      polls:    polls.length,
      failed:   polls.filter(([, seen]) => seen === null).length
    }
  }
  return { day, file: fileOf(day), sha256: await contentHash(file), bytes: file.length, sources: { buses: counts("buses"), predictions: counts("predictions") } }
}

/** The catalog with manifests in, each replacing any of its day, in order of day */
export const catalogWith = (catalog: Catalog, manifests: readonly Manifest[]): Catalog => ({
  days: [...new Map([...catalog.days, ...manifests].map(manifest => [manifest.day, manifest])).values()]
    .sort((a, b) => a.day.localeCompare(b.day))
})

/**
 * Every day from one to another, the first alone by default, that has settled by an instant and isn't archived, the
 * oldest first
 */
export const daysToArchive = (now: number, archived: readonly Day[], from: Day, to = from) => {
  const last = [to, lastSettled(now)].sort()[0]
  const days: Day[] = []
  for (let day = from; day <= last; day = addDays(day, 1))
    if (!archived.includes(day))
      days.push(day)
  return days
}

const readJson = async <T,>(schema: v.GenericSchema<unknown, T>, path: string) =>
  checked(schema, JSON.parse(await readFile(path, "utf8")), path)

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  if (command === "days") {
    const [{ buses }, { days }] = await Promise.all([health(), fetchCatalog()])
    // From the service day of the Worker's oldest samples, the Durham day before the first's at the earliest
    const oldest = buses.since === null ? undefined : addDays(localDay(buses.since), -1)
    const [from = oldest, to = args.length ? from : lastSettled(Date.now())] = args.map(arg => v.parse(Day, arg))
    if (from)
      console.log(daysToArchive(Date.now(), days.map(({ day }) => day), from, to).join("\n"))
  }
  else if (command === "pack") {
    const [day, folder] = [v.parse(Day, args[0]), args[1]]
    const rows = await storedRows(day)
    if (!rows.length)
      console.log(`Nothing is stored for ${day}`)
    else {
      const file = await pack(rows)
      // Packing must be lossless before anything's published, as D1 drops the samples once the day is cataloged
      if (!isDeepStrictEqual(await unpack(fileOf(day), Readable.from([file])), rows.toSorted(byMinute)))
        throw new Error(`The archive of ${day} doesn't read back as its rows`)
      const manifest = await manifestOf(day, rows, file)
      await mkdir(folder, { recursive: true })
      await writeFile(`${folder}/${fileOf(day)}`, file)
      await writeFile(`${folder}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
      console.log(`${day}: ${SOURCES.map(source => `${manifest.sources[source].rows} minutes of ${source}`).join(", ")}, ${manifest.bytes} bytes`)
    }
  }
  else if (command === "catalog") {
    const [catalog, ...manifests] = args
    console.log(JSON.stringify(catalogWith(await readJson(Catalog, catalog), await Promise.all(manifests.map(path => readJson(Manifest, path))))))
  }
  else
    throw new Error(`No command ${command}; days, pack, or catalog`)
}
