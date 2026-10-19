// Archives what the Worker observed on completed service days, for the Observations workflow
// (.github/workflows/archive.yml) to publish as src/map/archive.mts says: a day's stored rows, decoded, as one
// gzipped ndjson file, packed the same way every time, so the same rows make the same bytes, with its manifest, and
// the catalog with the manifests merged in. Gzip rather than brotli or zstd, which are a fifth smaller, as zcat,
// Node, and browsers' DecompressionStream all read it. Reads the Worker with BUILD_TOKEN, and writes only files:
//   node scripts/archive.mts days [from [to]]                  the settled days of a range, by default the last 7
//   node scripts/archive.mts pack <day> <folder>               the day's file and manifest.json, if it has any rows
//   node scripts/archive.mts catalog <catalog.json> <manifest.json>…   the catalog with the manifests merged in

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { gzipSync } from "node:zlib"
import * as v from "valibot"
import type { ObservedRow } from "../src/map/raw.mts"
import { Catalog, Manifest, fileOf } from "../src/map/archive.mts"
import { Day, addDays } from "../src/shared/time.mts"
import { checked } from "../src/shared/json.mts"
import { sha256 } from "./map/release.mts"
import { SOURCES, byMinute, lastSettled, storedRows, unpack } from "./observations.mts"

// Days the nightly run looks back over, so a night or six it failed are archived by the next
const LOOKBACK = 7

/** Rows a line each, in the order of their minutes */
export const pack = (rows: readonly ObservedRow[]) =>
  gzipSync(rows.toSorted(byMinute).map(row => `${JSON.stringify(row)}\n`).join(""), { level: 9 })

export const manifestOf = (day: Day, rows: readonly ObservedRow[], file: Uint8Array): Manifest => {
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
  return { day, sha256: sha256(file), bytes: file.length, sources: { buses: counts("buses"), predictions: counts("predictions") } }
}

/** The catalog with manifests in, each replacing any of its day, in order of day */
export const catalogWith = (catalog: Catalog, manifests: readonly Manifest[]): Catalog => ({
  days: [...new Map([...catalog.days, ...manifests].map(manifest => [manifest.day, manifest])).values()]
    .sort((a, b) => a.day.localeCompare(b.day))
})

/** Every day from one to another that has settled by an instant, by default the last few settled */
export const daysToArchive = (now: number, from?: Day, to?: Day) => {
  const last = [to ?? from ?? lastSettled(now), lastSettled(now)].sort()[0]
  const days: Day[] = []
  for (let day = from ?? addDays(last, 1 - LOOKBACK); day <= last; day = addDays(day, 1))
    days.push(day)
  return days
}

const readJson = async <T,>(schema: v.GenericSchema<unknown, T>, path: string) =>
  checked(schema, JSON.parse(await readFile(path, "utf8")), path)

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  if (command === "days")
    console.log(daysToArchive(Date.now(), ...args.map(arg => v.parse(Day, arg))).join("\n"))
  else if (command === "pack") {
    const [day, folder] = [v.parse(Day, args[0]), args[1]]
    const rows = await storedRows(day)
    if (!rows.length)
      console.log(`Nothing is stored for ${day}`)
    else {
      const file = pack(rows)
      // Packing must be lossless before anything's published, as the samples go once it is
      if (!isDeepStrictEqual(unpack(file), rows.toSorted(byMinute)))
        throw new Error(`The archive of ${day} doesn't read back as its rows`)
      const manifest = manifestOf(day, rows, file)
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
