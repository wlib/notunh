/** @jsxImportSource bruh/browser */

import { r } from "bruh/reactive"
import type { Counts, Kind, Machine } from "../infer.mts"
import { roomName } from "../rooms.mts"
import { favorites, hourOfWeek, toggleFavorite, usually } from "../state.mts"
import { ClockTime, Count, Plural } from "../../shell/intl.tsx"
import { Icon } from "../../shell/ui.tsx"

export const plural = (kind: Kind) =>
  `${kind}s`

/** Lit while the room is a favorite */
export const Star = ({ id }: { id: string }) =>
  <button
    type="button"
    class="star"
    aria-label={`Favorite ${roomName(id)}`}
    aria-pressed={r(() => favorites.value.has(id) ? "true" : "false")}
    onclick={() => toggleFavorite(id)}
  >
    <Icon name="star" />
  </button>

/** Like "~9:40 PM", with the ~ when it's our guess rather than a machine's own countdown */
export const When = ({ at, isSure }: { at: number, isSure?: boolean }) =>
  <>{isSure ? "" : "~"}<ClockTime at={new Date(at)} /></>

/** A machine's number, and which of a stacked pair it is: "7 ↑" for the upper */
export const Number = ({ machine }: { machine: Machine }) =>
  <span class="machine-number">
    {machine.number}
    {machine.stack && <> <span aria-hidden="true">{machine.stack === "upper" ? "↑" : "↓"}</span><span class="visually-hidden">{machine.stack}</span></>}
  </span>

/** When none is free, when the next should be: "next ~9:40 PM", or that one's done but not emptied; in short where there's little room */
export const Next = ({ counts, now, isShort }: { counts: Counts, now: number, isShort?: boolean }) =>
  counts.nextAt === undefined ? null :
  counts.nextAt <= now        ? <span class="muted">{isShort ? "done, not emptied" : "one done, not yet emptied"}</span> :
                                <span class="muted">{!isShort && "next "}<When at={counts.nextAt} isSure={counts.isSure} /></span>

/** Like "3 of 6 washers free", the free count lit when there's one, and when none is free, when the next should be */
export const Free = ({ kind, counts, now }: { kind: Kind, counts: Counts, now: number }) =>
  <>
    <strong class={{ live: counts.free > 0 }}><Count value={counts.free} /></strong>
    {" of "}
    <Plural value={counts.total} one={<><Count value={1} /> {kind}</>} other={<><Count value={counts.total} /> {plural(kind)}</>} />
    {" free"}
    {counts.nextAt !== undefined && <>, <Next counts={counts} now={now} /></>}
  </>

/** "Usually busy now" or "Usually quiet now", or nothing when it's neither or we can't say yet */
export const Usually = ({ id }: { id: string }) =>
  r(() => {
    const word = usually(id, hourOfWeek.value)
    return word && <span class="usually" data-usually={word}>Usually {word} now</span>
  })
