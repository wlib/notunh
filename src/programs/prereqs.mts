// Every Durham course's prerequisites, for the course page's two lines: Needs, what it takes first, and Unlocks, the
// courses it's among the prerequisites of; and Durham's programs, for a program's view of its courses by what each
// needs (program.mts, graph.mts). scripts/programs/prereqs.mts reads both from the catalog (catalog.mts,
// requirements.mts) as the inputs are made, into files named by their contents under /data/programs/, which a page
// loads only once a course or a program is opened, and a small index naming them, which a page's head may name as
// its data, as dining's does its files

import * as v from "valibot"
import { objectOf } from "../shared/json.mts"
import { type Req, renderReq } from "./req.mts"

/** The index, by its path in the repository */
export const PREREQS = "src/programs/prereqs.json"

export const DATA_PATH = "/data/programs/"

/**
 * The index: when the catalog was read, the file of prerequisites, and the list of programs (program.mts), whose
 * files the service worker keeps with it once loaded
 */
export const PrereqsIndex = v.object({
  /** Epoch milliseconds the catalog was fetched, 0 if it never was */
  fetched:  v.number(),
  /** The catalog's year read, like "2026-2027", absent before one was */
  year:     v.optional(v.string()),
  /** The file of Prereqs, absent if there's none */
  file:     v.optional(v.string()),
  /** The file of Programs, absent if there's none */
  programs: v.optional(v.string()),
  /** Every file in use, by path, which the service worker keeps with the index (Retain in src/shell/manifest.mts) */
  files:    v.array(v.string())
})
export type PrereqsIndex = v.InferOutput<typeof PrereqsIndex>

/** What a course needs and unlocks, either absent if it has none */
export type CourseReqs = { needs?: Req, unlocks?: string[] }

/** Every Durham course with prerequisites or among another's, by code, as "CS 518" */
export type Prereqs = {
  /** Epoch milliseconds the catalog was fetched */
  fetched: number,
  courses: Record<string, CourseReqs>
}

/** The file of prerequisites, taken on trust past its shape, as it's ours and big */
export const Prereqs = v.object({ fetched: v.number(), courses: objectOf<Record<string, CourseReqs>>() })

/** The empty index of inputs made before the catalog was read */
export const NO_PREREQS: PrereqsIndex = { fetched: 0, files: [] }

/** What a course needs, as its Needs line, and the codes of what it unlocks, in order; both empty for none */
export const reqsOf = (prereqs: Prereqs, code: string) => {
  const { needs, unlocks = [] } = prereqs.courses[code] ?? {}
  return { needs: needs ? renderReq(needs) : "", unlocks }
}
