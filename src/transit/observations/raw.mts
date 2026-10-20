// What the Worker keeps of the live API, one row per source per minute it polled, and how anything reads it back.
// Rows hold tuples rather than objects to keep the Worker's stringify cheap and the gzip small. Ids repeat across a
// minute's fixes, and gzip takes care of that without a dictionary.
//
// What's kept is a normalization of Umo's answers, not the answers: fields are dropped, times made relative, and
// predictions cut to the soonest per key. Each row names the version it was packed by, so a later reader knows what
// it's reading. A row also keeps every poll its minute made, failed ones too, so a minute without a fix says whether
// no bus was out or no answer came

import type { StopPredictions, Vehicle } from "./umo.mts"

/**
 * The version of this normalization, named in every row. 3 times each poll by when its answer came, or it failed. 2
 * timed it by when it was asked, up to its timeout earlier, and was the first with the minute's polls, and on each fix
 * the poll that first saw it. 1 is the tuples without them. Rows from before versioning are bare arrays of version
 * 1's tuples, which read as version 0
 */
export const RAW_VERSION = 3

export type Version = 0 | 1 | 2 | typeof RAW_VERSION

/** A poll as stored: when it was answered or failed, at seconds relative to the start of the row's minute, and how many live vehicles Umo listed, or null if it failed */
export type RawPoll = [at: number, seen: number | null]

/** A vehicle's fix as stored, at seconds relative to the start of the row's minute */
export type RawFix = [
  vehicle: string,
  at:      number,
  lat:     number,
  lon:     number,
  heading: number | null,
  kph:     number | null,
  trip:    string | null,
  route:   string | null,
  /** The stop Umo has it at, only while it's there */
  stop:    string | null,
  /** The poll that first saw it, by its place in the row's polls, from version 2 */
  poll?:   number
]

/** A vehicle's next arrival or departure at a stop as stored, at seconds relative to the start of the row's minute */
export type RawPrediction = [
  route:     string,
  stop:      string,
  vehicle:   string,
  trip:      string | null,
  at:        number,
  isLayover: 0 | 1
]

/** A row as read back: the version it was packed by, what it saw, and the polls it made, which rows before version 2 don't say */
export type Row<T> = { version: Version, samples: T[], polls: RawPoll[] | null }

/** A stored row of either source, decoded, which is also a line of the archive (scripts/archive.mts) */
export type ObservedRow =
  | { source: "buses", at: number } & Row<RawFix>
  | { source: "predictions", at: number } & Row<RawPrediction>

export type Source = ObservedRow["source"]

export type BusFix = {
  vehicle:   string,
  /** Epoch milliseconds the bus took the fix */
  at:        number,
  lat:       number,
  lon:       number,
  heading:   number | null,
  kph:       number | null,
  trip:      string | null,
  route:     string | null,
  stop:      string | null,
  /** Epoch milliseconds the poll that first saw it was answered, from version 3, or asked, in version 2 */
  received?: number
}

export type SampledPrediction = {
  route:     string,
  stop:      string,
  vehicle:   string,
  trip:      string | null,
  /** Epoch milliseconds Umo expects the bus */
  at:        number,
  /** The bus hadn't started the trip, so this was Umo's schedule rather than a forecast */
  isLayover: boolean
}

/** A poll as read back: the epoch millisecond it was answered or failed, and how many live vehicles Umo listed, or null if it failed */
export type Poll = { at: number, seen: number | null }

/** What a source's rows say of when it was looking */
export type Coverage = {
  /** Every poll recorded, in order */
  polls:      Poll[],
  /** The minutes stored before rows recorded their polls, which say only that something was seen */
  unrecorded: number[]
}

/** Everything a span of rows saw, and when it was looking */
export type Observations = {
  fixes:       BusFix[],
  predictions: { at: number, predictions: SampledPrediction[] }[],
  coverage:    Record<Source, Coverage>
}

// Each row is at the epoch millisecond its minute starts
const relative = (at: number, ms: number) =>
  (ms - at) / 1000

const absolute = (at: number, seconds: number) =>
  at + Math.round(seconds * 1000)

/** A poll answered at an epoch millisecond, seeing some live vehicles, or null for none as it failed then */
export const packPoll = (at: number, made: number, seen: number | null): RawPoll =>
  [relative(at, made), seen]

/** Every vehicle's fix, first seen by a poll, with null for whatever else Umo didn't say of it */
export const packFixes = (at: number, vehicles: readonly Vehicle[], poll: number): RawFix[] =>
  vehicles.map(vehicle => [
    vehicle.id,
    relative(at, vehicle.gpsTime),
    vehicle.lat,
    vehicle.lon,
    vehicle.heading ?? null,
    vehicle.kph ?? null,
    vehicle.tripTag ?? null,
    vehicle.route?.id ?? null,
    vehicle.vehiclePosition?.atCurrentStop === true ? vehicle.vehiclePosition.currentStopTag ?? null : null,
    poll
  ])

export const unpackFixes = (at: number, { samples, polls }: Row<RawFix>): BusFix[] =>
  samples.map(([vehicle, seconds, lat, lon, heading, kph, trip, route, stop, poll]) => ({
    vehicle, at: absolute(at, seconds), lat, lon, heading, kph, trip, route, stop,
    ...polls && poll !== undefined && { received: absolute(at, polls[poll][0]) }
  }))

/** Only the soonest prediction for each route, stop, and vehicle, which is all a later forecast can be scored against */
export const packPredictions = (at: number, entries: readonly StopPredictions[]): RawPrediction[] => {
  const soonest = new Map<string, RawPrediction>()
  for (const { route, stop, values } of entries)
    for (const { vehicleId, tripId, timestamp, affectedByLayover } of values) {
      const key = `${route.id}:${stop.id}:${vehicleId}`
      const seconds = relative(at, timestamp)
      const current = soonest.get(key)
      if (!current || seconds < current[4])
        soonest.set(key, [route.id, stop.id, vehicleId, tripId ?? null, seconds, affectedByLayover ? 1 : 0])
    }
  return [...soonest.values()]
}

export const unpackPredictions = (at: number, { samples }: Row<RawPrediction>): SampledPrediction[] =>
  samples.map(([route, stop, vehicle, trip, seconds, isLayover]) =>
    ({ route, stop, vehicle, trip, at: absolute(at, seconds), isLayover: isLayover === 1 })
  )

/** Everything rows saw, in the order of their minutes, and each source's polls */
export const observe = (rows: readonly ObservedRow[]): Observations => {
  const observed: Observations = {
    fixes:       [],
    predictions: [],
    coverage:    { buses: { polls: [], unrecorded: [] }, predictions: { polls: [], unrecorded: [] } }
  }
  for (const row of rows.toSorted((a, b) => a.at - b.at)) {
    const { polls, unrecorded } = observed.coverage[row.source]
    if (row.polls)
      polls.push(...row.polls.map(([seconds, seen]) => ({ at: absolute(row.at, seconds), seen })))
    else
      unrecorded.push(row.at)
    if (row.source === "buses")
      observed.fixes.push(...unpackFixes(row.at, row))
    else
      observed.predictions.push({ at: row.at, predictions: unpackPredictions(row.at, row) })
  }
  return observed
}

/** For what's known with nothing said of when it was looked for, like visits stored without their fixes */
export const alwaysListening = (_from: number, _to: number) => true

/**
 * Whether a source was listening throughout a span of epoch milliseconds, so what it didn't see then wasn't there:
 * answered polls either side of the span, none of them further apart than `gap` across it. Rows from before polls
 * were recorded say nothing of when it was listening, so with any of them, it's taken to have been
 */
export const listening = ({ polls, unrecorded }: Coverage, gap: number) => {
  if (unrecorded.length)
    return alwaysListening
  const heard = polls.flatMap(({ at, seen }) => seen === null ? [] : [at])
  // How many silences longer than gap come before each answered poll
  let silences = 0
  const before = heard.map((at, i) => silences += +(i > 0 && at - heard[i - 1] > gap))
  return (from: number, to: number) => {
    const [first, last] = [heard.findLastIndex(at => at <= from), heard.findIndex(at => at >= to)]
    return first >= 0 && last >= 0 && before[first] === before[last]
  }
}

/** A row's body: gzipped JSON of the version, the samples, and the polls */
export const encode = async (samples: readonly unknown[], polls: readonly RawPoll[]) =>
  new Uint8Array(await new Response(new Blob([JSON.stringify({ version: RAW_VERSION, samples, polls })]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer())

/** A row and the version it was packed by. Throws for a version it doesn't know rather than misread it */
export const decode = async <T,>(body: Uint8Array<ArrayBuffer>): Promise<Row<T>> => {
  const row: unknown = JSON.parse(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip"))).text())
  if (Array.isArray(row))
    return { version: 0, samples: row, polls: null }
  const { version, samples, polls } = Object(row) as { version?: unknown, samples?: unknown, polls?: unknown }
  if (version === 1 && Array.isArray(samples))
    return { version, samples, polls: null }
  if ((version === 2 || version === RAW_VERSION) && Array.isArray(samples) && Array.isArray(polls))
    return { version, samples, polls }
  throw new Error(`Not a row this reads, of version ${version}, as it reads up to ${RAW_VERSION}`)
}

/** A body as SQLite's hex() writes it, which is how rows travel as JSON */
export const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], byte => parseInt(byte, 16))
