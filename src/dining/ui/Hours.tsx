/** @jsxImportSource bruh/browser */

// Whether a hall is open now, and its hours on the day being looked at

import { r } from "bruh/reactive"
import { index, hall, day, now, hallStatus, hallName } from "../state.mts"
import type { Span } from "../menus.mts"
import { spansOn, wallDate, type WallTime } from "../hours.mts"
import { addDays, type Day as CalendarDay } from "../../shared/time.mts"
import { slug } from "../../shared/slug.mts"
import { ClockRange, ClockTime, Day, relativeDay } from "../../shell/intl.tsx"

const HOURS_PAGE = "https://www.unh.edu/dining/about/hours-operation"

/** Lit when the hall is open now */
export const OpenDot = ({ id }: { id: string }) =>
  r(() => {
    const status = hallStatus.value[id]
    return status &&
      <span
        class="open-dot"
        data-open={status.isOpen ? "true" : "false"}
        role="img"
        aria-label={status.isOpen ? "Open now" : "Closed now"}
      />
  })

const Time = ({ at }: { at: WallTime }) =>
  <ClockTime at={wallDate(at)} timeZone="UTC" />

/** Like "7:15 AM – 9:00 PM", with a range running past midnight as two times, since together they'd get dates */
const Range = ({ day, span: [open, close] }: { day: CalendarDay, span: Span }) =>
  close > 1440
    ? <><Time at={{ day, minute: open }} /> – <Time at={{ day, minute: close }} /></>
    : <ClockRange from={wallDate({ day, minute: open })} to={wallDate({ day, minute: close })} timeZone="UTC" />

/** When a closed hall opens next, like "5:00 PM", "tomorrow 8:00 AM", or "Mon 7:15 AM" */
const Opens = ({ at }: { at: WallTime }) =>
  <>
    {at.day === now.value.day
      ? ""
      : at.day === addDays(now.value.day, 1)
        ? `${relativeDay(1).toLocaleLowerCase()} `
        : <><Day of={at.day} weekday="short" />{" "}</>
    }
    <Time at={at} />
  </>

export const HallHours = () =>
  r(() => {
    const hours = index.hours[hall.value]
    if (!hours)
      return null

    const special = hours.special?.[day.value]
    const spans = spansOn(hours, day.value)
    const status = hallStatus.value[hall.value]

    return (
      <p class="hall-hours">
        <span>
          {day.value === now.value.day
            ? status.isOpen
              ? <><strong class="live">Open</strong> until <Time at={status.closes} /></>
              : <><strong>Closed</strong>{status.opens && <> · opens <Opens at={status.opens} /></>}</>
            : spans.length
              ? <>Hours {spans.map((span, i) => <>{i > 0 && ", "}<Range day={day.value} span={span} /></>)}</>
              : <strong>Closed all day</strong>
          }
          {special && <span class="muted"> · {special.note}</span>}
        </span>
        <span class="links">
          <a href={HOURS_PAGE} target="_blank" rel="noopener">Hours vary on breaks</a>
          <a href={`/map/?to=dining/${slug(hallName(hall.value))}`}>Directions</a>
        </span>
      </p>
    )
  })
