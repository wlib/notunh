// Picking an event's time together (docs/social.md): the host offers up to three times, and anyone marks each one
// that works for them, one mark a device a time, which says that and nothing more. The host sets one, which makes
// it an ordinary event, and whoever marked that time is asked "Going?" (ask.mts). Going exists only once a time is
// set, as a count, and an event with spots fills: nobody is ever made going, or not, by another's tap

import type { Event, Pin, Time } from "./event.mts"

/** Whether an event's time is still to pick: it offers times, and none is set */
export const isUnset = (event: Event | Pick<Pin, "times" | "chosen">) =>
  "times" in event && event.times.length > 0 && event.chosen === undefined

/** Times earliest first, as an event keeps them */
export const sortedTimes = (times: readonly Time[]): Time[] =>
  [...times].sort((a, b) => a.start - b.start || a.end - b.end)

/** The window an event spans while its time is to pick: from the first start to the last end */
export const spanOf = (times: readonly Time[]): Time =>
  ({ start: Math.min(...times.map(time => time.start)), end: Math.max(...times.map(time => time.end)) })

/** Whether every spot is taken */
export const isFull = (pin: Pick<Pin, "going" | "spots">) =>
  pin.spots !== undefined && pin.going >= pin.spots

/** What the Going button says: the count, of the spots where there are some, or that it's full to one not going */
export const goingWords = (pin: Pick<Pin, "going" | "spots" | "isGoing">) =>
  isFull(pin) && !pin.isGoing ? "Full" : `Going · ${pin.going}${pin.spots === undefined ? "" : ` of ${pin.spots}`}`
