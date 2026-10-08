/** @jsxImportSource bruh/browser */

// When a room usually has machines free today, by the hour

import { r } from "bruh/reactive"
import { KINDS, type Kind } from "../infer.mts"
import { hourOfWeek, usual, usualWeek } from "../state.mts"
import { plural } from "./common.tsx"

type Week = NonNullable<ReturnType<typeof usualWeek>>

const HOURS = ["12a", "6a", "12p", "6p"]

/** An SVG element, made by hand as bruh's JSX types don't know SVG's attributes */
const svg = (name: string, attributes: Record<string, string | number>, ...children: Node[]) => {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name)
  for (const [attribute, value] of Object.entries(attributes))
    element.setAttribute(attribute, `${value}`)
  element.append(...children)
  return element
}

/** Bars of the usual free count each hour of a day, hollow where we haven't watched enough, with this hour marked */
const Sparkline = ({ week, total, slot }: { week: Week, total: number, slot: number }) => {
  const day = slot - slot % 24
  return svg("svg", { class: "sparkline", viewBox: "0 0 240 40", preserveAspectRatio: "none", "aria-hidden": "true" },
    ...week.slice(day, day + 24).map((hour, i) => {
      const height = hour ? Math.max(1, 40 * Math.min(1, hour.free / total)) : 40
      return svg("rect", { x: i * 10 + 1, y: 40 - height, width: 8, height, class: !hour ? "unknown" : day + i === slot ? "now" : "bar" })
    })
  )
}

const kindsWithData = (id: string) =>
  KINDS
    .map(kind => ({ kind, week: usualWeek(id, kind), total: usual.value.rooms[id]?.[kind]?.total ?? 0 }))
    .filter((entry): entry is { kind: Kind, week: Week, total: number } => entry.total > 0 && (entry.week?.some(Boolean) ?? false))

const Usual = ({ id, slot }: { id: string, slot: number }) => {
  const kinds = kindsWithData(id)
  if (!kinds.length)
    return null
  return (
    <section class="usual">
      <h2 class="eyebrow">Usually free today</h2>
      <div class="sparklines">
        {kinds.map(({ kind, week, total }) =>
          <figure>
            <figcaption>{plural(kind)}</figcaption>
            <Sparkline week={week} total={total} slot={slot} />
            <div class="axis muted" aria-hidden="true">{HOURS.map(hour => <span>{hour}</span>)}</div>
          </figure>
        )}
      </div>
    </section>
  )
}

/** Redrawn when the hour changes or the model loads, rather than every tick */
export const UsualView = ({ id }: { id: string }) =>
  r(() => <Usual id={id} slot={hourOfWeek.value} />)
