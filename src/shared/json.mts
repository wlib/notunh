// Fetching JSON, which the pages, the Worker, and the build all do the same way. Given a schema (any Standard Schema,
// https://standardschema.dev), the answer is checked against it, so a file or answer of the wrong shape fails where
// it's fetched, like a failed fetch, rather than wherever it's first misread. Ours are Valibot's, and the helpers
// below are the few every boundary shares

import * as v from "valibot"
import type { StandardSchemaV1 } from "@standard-schema/spec"

// Issues named in an error, of however many
const NAMED = 3

/** What a check found wrong, on one line: the first few issues, each where it was, if anywhere, and what */
export const describeIssues = (issues: readonly StandardSchemaV1.Issue[]) =>
  issues.slice(0, NAMED).map(({ path, message }) => {
    const at = path?.map(part => String(typeof part === "object" ? part.key : part)).join(".")
    return at ? `${at}: ${message}` : message
  }).join("; ") + (issues.length > NAMED ? `; and ${issues.length - NAMED} more` : "")

/** A value as a schema makes it, or an error saying where it came from and what's wrong with it */
export const checked = async <T,>(schema: StandardSchemaV1<unknown, T>, value: unknown, from: string | URL): Promise<T> => {
  const result = await schema["~standard"].validate(value)
  if (result.issues)
    throw new Error(`Unexpected JSON from ${from}: ${describeIssues(result.issues)}`)
  return result.value
}

/** A response's JSON, as its schema makes it if it has one, or an error saying what it answered instead */
export const readJson = async <T = unknown,>(response: Response, schema?: StandardSchemaV1<unknown, T>, from: string | URL = response.url): Promise<T> => {
  if (!response.ok)
    throw new Error(`${response.status} from ${from}`)
  const body: unknown = await response.json()
  return schema ? checked(schema, body, from) : body as T
}

/** What a URL answers with as JSON, as its schema makes it if it has one, or an error saying what it answered instead */
export const getJson = async <T = unknown,>(url: string | URL, { schema, ...init }: RequestInit & { schema?: StandardSchemaV1<unknown, T> } = {}): Promise<T> =>
  readJson(await fetch(url, init), schema, url)

/** A value as gzipped JSON, as the Worker keeps what it stores */
export const gzipJson = async (value: unknown) =>
  new Uint8Array(await new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer())

/** What gzipped JSON holds, from its bytes, which may come in parts */
export const gunzipJson = async (...parts: Uint8Array<ArrayBuffer>[]): Promise<unknown> =>
  JSON.parse(await new Response(new Blob(parts).stream().pipeThrough(new DecompressionStream("gzip"))).text())

const isObject = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** An array, its items taken on trust, for a big one of our own making that isn't worth checking item by item */
export const arrayOf = <T,>() =>
  v.custom<T[]>(Array.isArray, "Expected an array")

/** An object, likewise taken on trust past being one */
export const objectOf = <T,>() =>
  v.custom<T>(isObject, "Expected an object")

/** An array of whichever of its items fit, so a change upstream shows less rather than garbage */
export const usable = <S extends v.GenericSchema,>(item: S) =>
  v.pipe(
    v.array(v.unknown()),
    v.transform(items => items.flatMap(value => {
      const result = v.safeParse(item, value)
      return result.success ? [result.output] : []
    }))
  )
