// What we're willing to claim about a machine from its last report and a little history, and about a room from its
// machines. The controllers report every 20 minutes or so while running, so a countdown that recent is trustworthy,
// but a finished machine lingers as done until its door opens, and an idle one's stamp is only a heartbeat

import { DAY, HOUR } from "../shared/time.mts"

/** What the vendor's many status ids boil down to */
export type Status = "free" | "running" | "done" | "out"

const STATUS: Record<string, Status> = {
  AVAILABLE:         "free",
  READY_TO_START:    "free",
  SUSPECT_AVAILABLE: "free",
  IN_USE:            "running",
  COMPLETE:          "done",
  DONE:              "done",
  ERROR:             "out",
  NETWORK_ERROR:     "out",
  UNAVAILABLE:       "out",
  OUT_OF_ORDER:      "out",
  OFFLINE:           "out"
}

/** Ids we don't know, like one added upstream, are out until we do, since we can't say the machine is usable */
export const statusOf = (raw: string): Status =>
  Object.hasOwn(STATUS, raw) ? STATUS[raw] : "out"

export const STATUS_IDS = Object.keys(STATUS)

export const KINDS = ["washer", "dryer"] as const

export type Kind = typeof KINDS[number]

/** A machine as the page and the collector see it, normalized from the vendor's shape */
export type Machine = {
  id:        string,
  room:      string,
  number:    string,
  kind:      Kind,
  model:     string,
  /** Which of a stacked pair it is, when it's one */
  stack?:    "upper" | "lower",
  status:    Status,
  /** The vendor's own status id, for anything not mapped yet */
  raw:       string,
  /** Epoch milliseconds of the controller's last report */
  at:        number,
  /** Seconds the controller says are left, only meaningful while running; otherwise the cycle's default length */
  remaining: number,
  cycle?:    string
}

/** What the collector's records say about a machine, absent until it has run a while */
export type History = {
  /** Epoch milliseconds of the machine's last recorded status change */
  changedAt:     number,
  /** Epoch milliseconds of the last recorded change of any machine in its room, so a dead radio stands out from a quiet room */
  roomChangedAt: number
}

export type Assessment = {
  state:    Status,
  /** "reported" straight from a fresh report, "inferred" from timing, "stale" when the report is too old to trust */
  basis:    "reported" | "inferred" | "stale",
  /** Epoch milliseconds a running machine should finish, or a done one finished */
  readyAt?: number,
  /** A short reason, like "no update for 12 min" */
  note?:    string
}

/** A status change as the collector records it, and the transitions row */
export type Transition = {
  machine:   string,
  room:      string,
  /** Epoch milliseconds */
  at:        number,
  status:    Status,
  raw:       string,
  remaining: number,
  cycle?:    string
}

/** A collector run, with the rooms it couldn't fetch, and the polls row */
export type Poll = { at: number, failed: readonly string[] }

/** A machine as the build reads it from the collector's latest rows */
export type Known = { machine: string, room: string, kind: Kind }

/** A room as the Worker answers /api/laundry/rooms/:id */
export type RoomLive = {
  /** Epoch milliseconds the machines were fetched */
  at:       number,
  /** The vendor couldn't be reached, so this is the collector's last record */
  isStale:  boolean,
  machines: Machine[],
  /** By machine id, for machines the collector has seen */
  history:  Record<string, History>
}

// Running machines report about every 20 minutes, so one quiet longer than this missed a report, or finished
export const QUIET_RUNNING = 25 * 60_000
// A machine unchanged this long while its room has changed since is a dead radio, whatever it claims
export const DEAD_AFTER = 3 * DAY
// Clothes sitting in a finished machine this long usually mean the door sensor missed them being taken out
const FORGOTTEN_AFTER = 2 * HOUR

export const assess = (m: Machine, now: number, history?: History): Assessment => {
  // The vendor says it's broken or unreachable, and it's rarely wrong that way round
  if (m.status === "out")
    return { state: "out", basis: "reported", note: m.raw.toLowerCase().replaceAll("_", " ") }

  // Nothing's changed or even reported for days while its neighbors have changed, so whatever it last said is fiction
  if (history && now - history.changedAt > DEAD_AFTER && now - m.at > DEAD_AFTER && history.roomChangedAt > history.changedAt)
    return { state: "out", basis: "stale", note: "not reporting" }

  if (m.status === "running") {
    const endAt = m.at + m.remaining * 1000
    // A fresh countdown is the controller's own, and topping off pushes it out on its own
    if (now - m.at < QUIET_RUNNING)
      return { state: "running", basis: "reported", readyAt: Math.max(endAt, now) }
    // Quiet past its end: it finished and the radio missed it, so it's done but still has someone's clothes in it
    if (now > endAt + QUIET_RUNNING)
      return { state: "done", basis: "inferred", readyAt: endAt, note: "probably done" }
    return { state: "running", basis: "stale", readyAt: Math.max(endAt, now), note: `no update for ${Math.round((now - m.at) / 60_000)} min` }
  }

  if (m.status === "done")
    // Hours of waiting to be emptied most likely means it was, and the door sensor missed it
    return now - m.at > FORGOTTEN_AFTER
      ? { state: "free", basis: "inferred", note: "finished hours ago" }
      : { state: "done", basis: "reported", readyAt: Math.min(m.at, now), note: "done, not emptied" }

  // The stamp on a free machine is a heartbeat, not when it became free
  return { state: "free", basis: "reported" }
}

export type Counts = {
  total: number,
  free:  number,
  done:  number,
  out:   number,
  /** The soonest one should be free, when none is now and one's running or done */
  nextAt?: number,
  /** Whether that's a running machine's fresh countdown rather than a guess */
  isSure?: boolean
}

export type RoomSummary = Record<Kind, Counts>

/** Every room's counts as the Worker answers /api/laundry/rooms, from the collector's latest records */
export type Summaries = {
  /** Epoch milliseconds the counts were made */
  at:    number,
  /** By room id, each as of its machines' last reports; a room is missing until the collector has seen it */
  rooms: Record<string, RoomSummary & { at: number }>
}

const count = (assessed: readonly Assessment[]): Counts => {
  const counts: Counts = { total: assessed.length, free: 0, done: 0, out: 0 }
  for (const { state } of assessed)
    if (state !== "running")
      counts[state]++
  if (counts.free)
    return counts
  // A done machine frees up once it's emptied, which could be any minute, so it's never a sure thing
  const next = assessed
    .filter(({ state }) => state === "running" || state === "done")
    .reduce<Assessment | undefined>((soonest, a) => !soonest || a.readyAt! < soonest.readyAt! ? a : soonest, undefined)
  return next
    ? { ...counts, nextAt: next.readyAt, isSure: next.state === "running" && next.basis === "reported" }
    : counts
}

/** Each kind's counts, from a room's machines and their assessments in the same order */
export const summarize = (machines: readonly Machine[], assessed: readonly Assessment[]): RoomSummary => ({
  washer: count(assessed.filter((_, i) => machines[i].kind === "washer")),
  dryer:  count(assessed.filter((_, i) => machines[i].kind === "dryer"))
})

/**
 * A room's machines in order, with what we make of each and its counts, as of a time: by number, so a stacked pair
 * sits side by side, and out-of-order ones last, where they're out of the way
 */
export const assessRoom = (room: RoomLive, at: number) => {
  const assessed = new Map(room.machines.map(machine => [machine, assess(machine, at, room.history[machine.id])]))
  const machines = room.machines.toSorted((a, b) =>
    +(assessed.get(a)!.state === "out") - +(assessed.get(b)!.state === "out") || a.number.localeCompare(b.number, "en", { numeric: true })
  )
  const inOrder = machines.map(machine => assessed.get(machine)!)
  return { machines, assessed: inOrder, summary: summarize(machines, inOrder) }
}
