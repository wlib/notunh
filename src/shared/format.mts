// One rule for data that outlives the code that wrote it, and so meets code older or newer than its own: a build's
// data files in an open page, a learned model, what a device keeps, what's kept for a person across their devices.
// Each has a format: a version, the schema of that version, and what makes each older version into the next. Data
// says its own version, a whole number above 0 under `version`; data that says none, as all of it did before formats
// were, is version 0. So nothing stored had to change, and nothing beside the data has to agree with it. Whoever reads
// asks read(), and gets one of three answers, the same everywhere:
// - a value: the data is of this version, or of an older one brought up through every upgrade since, and fits
// - newer: code newer than this wrote it. It's never guessed at and never written over: a build's file waits for the
//   reload that brings its code, and what's kept stays as it is for code that knows it
// - issues: it's older than the upgrades reach, or isn't what its version's schema says, which reads as nothing there
// A schema tells shapes apart, so a version is for what it can't: bump it when a field keeps its name and type but
// means something else, or when older code would otherwise write over what it can't keep. A version another kind of
// thing goes by, as the timetable's or the tiles' own is, isn't a whole number, so it says nothing of the format

import type { StandardSchemaV1 } from "@standard-schema/spec"

type Schema<T> = StandardSchemaV1<unknown, T>

export type Format<T> = {
  /** The version this code reads and writes */
  version:  number,
  /** What data of that version is, checked at once, as Valibot's schemas are */
  schema:   Schema<T>,
  /** What makes each older version the next, the oldest first, so the last makes this one */
  upgrades: readonly ((older: unknown) => unknown)[]
}

/** What a value of a version carries, which is how what's written says its version: nothing for 0 */
type Saying<V extends number> = V extends 0 ? unknown : { version: V }

export type Read<T> = { value: T } | { newer: number } | { issues: readonly StandardSchemaV1.Issue[] }

/** A schema of whatever a function makes of anything, which never fails, as what a device keeps is read */
const reading = <T,>(read: (data: unknown) => T): Schema<T> =>
  ({ "~standard": { version: 1, vendor: "notunh", validate: value => ({ value: read(value) }) } })

/**
 * A format: a schema, or a function that reads anything, of a version, 0 unless given, with the upgrades from as far
 * back as it still reads. Each upgrade gives data that says the next version, so the last gives what the schema takes
 */
export const format = <T extends Saying<V>, V extends number = 0>(by: Schema<T> | ((data: unknown) => T), version = 0 as V, ...upgrades: Format<T>["upgrades"]): Format<T> => {
  if (!Number.isSafeInteger(version) || upgrades.length > version)
    throw new RangeError(`A format of version ${version} can't have ${upgrades.length} upgrades`)
  return { version, schema: typeof by === "function" ? reading(by) : by, upgrades }
}

/** The version data says it is: a whole number above 0 under version, or 0 for anything else */
export const versionOf = (data: unknown): number => {
  const { version }: { version?: unknown } = Object(data)
  return Number.isSafeInteger(version) && (version as number) > 0 ? version as number : 0
}

const issue = (message: string): Read<never> =>
  ({ issues: [{ message }] })

/** What this code makes of data: its value, that it's newer than this reads, or what's wrong with it */
export const read = <T,>({ version, schema, upgrades }: Format<T>, data: unknown): Read<T> => {
  const said = versionOf(data)
  if (said > version)
    return { newer: said }
  const oldest = version - upgrades.length
  if (said < oldest)
    return issue(`Version ${said} is older than ${oldest}, the oldest still read`)
  let current = data
  try {
    for (const upgrade of upgrades.slice(said - oldest))
      current = upgrade(current)
  }
  catch (error) {
    return issue(`Version ${said} couldn't be upgraded: ${error instanceof Error ? error.message : error}`)
  }
  if (versionOf(current) !== version)
    return issue(`Version ${said} was upgraded to ${versionOf(current)}, not ${version}`)
  const result = schema["~standard"].validate(current)
  if (result instanceof Promise)
    throw new TypeError("A format's schema is checked at once")
  return result.issues ? { issues: result.issues } : { value: result.value }
}

/**
 * What a format that reads anything makes of what's kept: its value, or what it makes of nothing where newer code
 * wrote it or it can't be read
 */
export const readKept = <T,>(by: Format<T>, kept: unknown): T => {
  const found = read(by, kept)
  const result = "value" in found ? found : read(by, null)
  if (!("value" in result))
    throw new TypeError("What's kept is read by a format that reads nothing as a value")
  return result.value
}
