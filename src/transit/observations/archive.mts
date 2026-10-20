// The lossless archive of what the Worker observed (src/transit/observations/raw.mts): each completed service day's stored rows of
// both sources, decoded, as one zstd-compressed ndjson file (gzipped before 2026-10-20) on its own immutable GitHub
// release, observations-<day>, with a manifest of it, and a catalog of every day archived, catalog.json on the one
// mutable release, observations, uploaded last (scripts/archive.mts, .github/workflows/archive.yml). The Worker
// keeps a day's samples past RETAIN_ARCHIVED_DAYS only while the catalog doesn't list it

import * as v from "valibot"
import { getJson } from "../../shared/json.mts"
import { Day } from "../../shared/time.mts"

const RELEASES = "https://github.com/wlib/notunh/releases/download/"
export const CATALOG = `${RELEASES}observations/catalog.json`

/** The name of a day's archive as it's written now */
export const fileOf = (day: Day) =>
  `observations-${day}.ndjson.zst`

/** Where a day's archive is, as its manifest names it, or before manifests named it, the gzipped file it was */
export const archiveUrl = ({ day, file }: Pick<Manifest, "day" | "file">) =>
  `${RELEASES}observations-${day}/${file ?? `observations-${day}.ndjson.gz`}`

/** What a source's rows of a day hold, and when it was looking */
export const Counts = v.object({
  rows:     v.number(),
  samples:  v.number(),
  /** The raw versions its rows were packed by */
  versions: v.array(v.number()),
  /** Its polls recorded, and of them those that failed */
  polls:    v.number(),
  failed:   v.number()
})
export type Counts = v.InferOutput<typeof Counts>

/** An archived day, as its manifest.json says: the file's name, SHA-256, and size, and each source's counts */
export const Manifest = v.object({
  day:     Day,
  /** From 2026-10-20, when the file became zstd's */
  file:    v.optional(v.string()),
  sha256:  v.string(),
  bytes:   v.number(),
  sources: v.object({ buses: Counts, predictions: Counts })
})
export type Manifest = v.InferOutput<typeof Manifest>

/** Every day archived, in order */
export const Catalog = v.object({ days: v.array(Manifest) })
export type Catalog = v.InferOutput<typeof Catalog>

/** The catalog, or an empty one while there's none, which only a 404 means */
export const fetchCatalog = (init?: RequestInit): Promise<Catalog> =>
  getJson(CATALOG, { ...init, schema: Catalog }).catch(error =>
    error instanceof Error && error.message.startsWith("404 ") ? { days: [] } : Promise.reject(error)
  )
