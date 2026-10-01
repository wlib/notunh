// Durham's clock, which every bus schedule and menu runs on

export const TIME_ZONE = "America/New_York"

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE })
const hourFormat = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", hourCycle: "h23" })

/** The date in Durham at an epoch millisecond, as YYYY-MM-DD */
export const localDay = (ms: number) =>
  dayFormat.format(ms)

/** The hour in Durham at an epoch millisecond, 0 to 23 */
export const localHour = (ms: number) =>
  +hourFormat.format(ms)
