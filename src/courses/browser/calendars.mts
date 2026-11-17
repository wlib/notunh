// Someone's own calendar, read for them (src/courses/imported.mts): a file is read where it is, and a feed's address
// is asked from this browser where its host lets a page read it, else through the Worker (worker/calendar.mts), which
// hands it straight back, as Canvas', Google's and Outlook's feeds say nothing to a page of another site. The
// address is a secret of theirs, so it goes in a request's body, never its address, and is kept only on this device

/** Whether a text is a calendar file */
const isCalendar = (text: string) =>
  /^﻿?\s*BEGIN:VCALENDAR/i.test(text)

/**
 * A feed's address as it's asked for and kept: https, as webcal means. None for anything else, which is never asked
 * for, as words typed in place of an address would be asked of this site, and kept in its logs
 */
export const addressOf = (typed: string) => {
  try {
    const url = new URL(typed.trim().replace(/^webcals?:/i, "https:"))
    return url.protocol === "https:" ? url : undefined
  }
  catch {
    // Not an address
  }
}

/** A calendar's text from its address, or an error saying why not in words a page shows as they are */
export const fetchCalendar = async (url: string): Promise<string> => {
  const direct = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" })
    .then(response => response.ok ? response.text() : undefined, () => undefined)
  if (direct !== undefined && isCalendar(direct))
    return direct
  const response = await fetch("/api/calendar/fetch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }).catch(() => {
    throw new Error(navigator.onLine ? "Couldn't reach notunh." : "You're offline.")
  })
  if (!response.ok)
    throw new Error(await response.text() || "That calendar couldn't be read.")
  return response.text()
}

/** A calendar file's text, or an error where it isn't one */
export const readCalendar = async (file: File): Promise<string> => {
  const text = await file.text()
  if (!isCalendar(text))
    throw new Error("That file isn't a calendar.")
  return text
}
