/** @jsxImportSource bruh/browser */

import type { Assessment, Machine } from "../infer.mts"
import { ClockTime, Minutes } from "../../shell/intl.tsx"
import { Number } from "./common.tsx"

const STATE_WORDS = { free: "Free", done: "Done", out: "Out" }

/** Whole minutes until a time, at least one */
export const minutesUntil = (at: number, now: number) =>
  Math.max(1, Math.ceil((at - now) / 60_000))

/**
 * A machine's number, what it's doing, and why we think so when it isn't straight from the machine: a running one
 * counts down to its finish time, with a ~ when the countdown is ours. When none of its kind is free, a bar as long
 * as its wait next to the longest, so the tiles read as a queue
 */
export const MachineTile = ({ machine, assessment, now, share }: { machine: Machine, assessment: Assessment, now: number, share?: number }) => {
  const { state, basis, readyAt, note } = assessment
  return (
    <li class="machine" data-state={state}>
      <Number machine={machine} />
      <strong>{state === "running" ? <>{basis === "reported" ? "" : "~"}<Minutes value={minutesUntil(readyAt!, now)} /></> : STATE_WORDS[state]}</strong>
      <span class="machine-note">
        {state === "running" && <>until {basis === "reported" ? "" : "~"}<ClockTime at={new Date(readyAt!)} /></>}
        {state === "running" && note && " · "}
        {note}
      </span>
      {share !== undefined && <span class="wait" style={`--share: ${share}`} aria-hidden="true" />}
    </li>
  )
}
