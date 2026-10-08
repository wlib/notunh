/** @jsxImportSource bruh/browser */

// Every laundry room, favorites first, with how many washers and dryers are free in each, in columns the eye can
// run down

import { r } from "bruh/reactive"
import { KINDS, type Counts, type Kind } from "../infer.mts"
import { ROOMS, pathOf } from "../rooms.mts"
import { favorites, open, summaryOf } from "../state.mts"
import { now } from "../../shell/lifecycle.mts"
import { Count } from "../../shell/intl.tsx"
import { Next, Star, Usually, plural } from "./common.tsx"

/** "6 of 7" with the free count lit, and under it when none is, when the next should be */
const Cell = ({ kind, counts }: { kind: Kind, counts: Counts | undefined }) =>
  <span class="cell">
    {counts
      ? <>
          <span class="count">
            <strong class={{ live: counts.free > 0 }}><Count value={counts.free} /></strong>
            <span class="muted"> of <Count value={counts.total} /></span>
            <span class="visually-hidden"> {plural(kind)} free</span>
          </span>
          <Next counts={counts} now={now.value} isShort />
        </>
      : <span class="muted" aria-label={`${plural(kind)} not checked yet`}>—</span>
    }
  </span>

const Row = ({ id, name }: { id: string, name: string }) =>
  <li class="room-row">
    <a
      href={pathOf(id)}
      class="room-open"
      onclick={event => {
        event.preventDefault()
        open(id)
      }}
    >
      <span class="room-name">
        <strong>{name}</strong>
        <Usually id={id} />
      </span>
      {r(() => {
        const summary = summaryOf(id, now.value)
        return KINDS.map(kind => <Cell kind={kind} counts={summary?.[kind]} />)
      })}
    </a>
    <Star id={id} />
  </li>

export const RoomList = () =>
  <>
    <ul class="rooms">
      <li class="rooms-head eyebrow" aria-hidden="true">
        <span>Room</span>
        <span>Washers free</span>
        <span>Dryers free</span>
      </li>
      {r(() =>
        ROOMS
          .toSorted((a, b) => +favorites.value.has(b.id) - +favorites.value.has(a.id))
          .map(room => <Row {...room} />)
      )}
    </ul>
    <footer class="muted">
      Counts update every few minutes. Select a room to see the latest machine status and remaining times.
    </footer>
  </>
