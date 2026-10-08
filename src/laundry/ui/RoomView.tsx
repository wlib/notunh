/** @jsxImportSource bruh/browser */

// One room: its washers and dryers by number, so yours is easy to find, except when none of a kind is free, when
// they come soonest first with a bar each, so the wall answers whether to walk over now; and when the room is
// usually busy

import { r } from "bruh/reactive"
import { KINDS, assessRoom } from "../infer.mts"
import { pathOf, roomName } from "../rooms.mts"
import { isOpenFailed, open, rooms, summaries } from "../state.mts"
import { slug } from "../../shared/slug.mts"
import { now } from "../../shell/lifecycle.mts"
import { ClockTime } from "../../shell/intl.tsx"
import { Icon } from "../../shell/ui.tsx"
import { MachineTile, minutesUntil } from "./Machine.tsx"
import { UsualView } from "./Usual.tsx"
import { Free, Star, Usually } from "./common.tsx"

const Machines = ({ id }: { id: string }) =>
  r(() => {
    const room = rooms.value[id]
    // Until the live word comes, the counts as the collector last saw them, which the list already had
    if (!room) {
      const summary = summaries.value[id]
      return (
        <>
          {summary && KINDS.filter(kind => summary[kind].total).map(kind =>
            <section class="kind"><h2><Free kind={kind} counts={summary[kind]} now={now.value} /></h2></section>
          )}
          <p class="empty muted">
            {isOpenFailed.value ? "Couldn't reach this room's machines. Check your connection, and we'll keep trying." : "Checking the machines…"}
          </p>
        </>
      )
    }

    const { machines, assessed, summary } = assessRoom(room, now.value)
    const at = <ClockTime at={new Date(room.at)} />
    return (
      <>
        {KINDS.filter(kind => summary[kind].total).map(kind => {
          const ofKind = machines.flatMap((machine, i) => machine.kind === kind ? [{ machine, assessment: assessed[i] }] : [])
          // With none free, the ones that'll free up come soonest first, out ones still last
          const isQueue = !summary[kind].free && ofKind.some(({ assessment }) => assessment.readyAt !== undefined)
          const minutes = ({ readyAt }: { readyAt?: number }) => readyAt === undefined ? Infinity : minutesUntil(readyAt, now.value)
          const longest = Math.max(...ofKind.map(({ assessment }) => assessment.readyAt === undefined ? 0 : minutes(assessment)))
          const shown = isQueue ? ofKind.toSorted((a, b) => minutes(a.assessment) - minutes(b.assessment)) : ofKind
          return (
            <section class="kind">
              <h2><Free kind={kind} counts={summary[kind]} now={now.value} /></h2>
              <ul class="machines">
                {shown.map(({ machine, assessment }) =>
                  <MachineTile
                    machine={machine}
                    assessment={assessment}
                    now={now.value}
                    share={isQueue && assessment.readyAt !== undefined ? (assessment.readyAt <= now.value ? 0 : minutes(assessment) / longest) : undefined}
                  />
                )}
              </ul>
            </section>
          )
        })}
        <footer class="muted">
          {room.isStale
            ? <>The machines couldn't be reached just now; this is what they last said, at {at}.</>
            : <>The machines report their own timers, as of {at}; a ~ marks our estimate.</>
          }
        </footer>
      </>
    )
  })

export const RoomView = ({ id }: { id: string }) =>
  <article class="room">
    <a
      href={pathOf(undefined)}
      class="back"
      onclick={event => {
        event.preventDefault()
        open(undefined)
      }}
    >
      <Icon name="forward" /> All rooms
    </a>
    <header>
      <div>
        <h2>{roomName(id)}</h2>
        <p class="room-meta">
          <Usually id={id} />
          <a href={`/map/?to=laundry/${slug(roomName(id))}`}>Directions</a>
        </p>
      </div>
      <Star id={id} />
    </header>
    <Machines id={id} />
    <UsualView id={id} />
  </article>
