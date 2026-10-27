// The story image a pin is shared as: 1080 by 1920, as Instagram stories are, with the title, day and time, place,
// a QR code of the pin's link, and the link in words, all within the middle, as Instagram lays its own controls
// over the top and bottom. Drawn on a canvas here on the phone, so nothing is rendered by a server, and shared as a
// file where the browser can, else downloaded; the link is put on the clipboard either way, for the link sticker

import { LIGHT, SURFACE } from "../shell/theme.mts"
import { type Event, type Pin, pinPath, whereOf } from "./event.mts"
import { isUnset } from "./marks.mts"
import { encode } from "./qr.mts"
import { TIME_ZONE } from "../shared/time.mts"

const STORY = { width: 1080, height: 1920 }
/** What's covered by Instagram's own bars, top and bottom */
const SAFE = 250
const { text: INK, muted: MUTED } = LIGHT

const when = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "long", month: "short", day: "numeric" })
const clock = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" })

/** Text broken into lines that fit a width, at most so many, the last cut with an ellipsis if it must be */
const wrapped = (context: CanvasRenderingContext2D, text: string, width: number, max: number) => {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (context.measureText(next).width <= width || !line)
      line = next
    else {
      lines.push(line)
      line = word
    }
  }
  lines.push(line)
  if (lines.length > max) {
    lines.length = max
    while (lines[max - 1].length > 1 && context.measureText(`${lines[max - 1]}…`).width > width)
      lines[max - 1] = lines[max - 1].slice(0, -1).trimEnd()
    lines[max - 1] += "…"
  }
  return lines
}

/** A QR code drawn dark on light, its modules this many pixels each, from a corner */
const drawCode = (context: CanvasRenderingContext2D, text: string, x: number, y: number, size: number) => {
  const { size: modules, modules: dark } = encode(text)
  const quiet = 4
  const scale = size / (modules + 2 * quiet)
  context.fillStyle = "white"
  context.fillRect(x, y, size, size)
  context.fillStyle = INK
  for (let r = 0; r < modules; r++)
    for (let c = 0; c < modules; c++)
      if (dark[r * modules + c])
        context.fillRect(x + (c + quiet) * scale, y + (r + quiet) * scale, scale + 0.5, scale + 0.5)
}

/** The story image of an event as a PNG, given the origin its link is on */
const storyImage = async (event: Event | Pin, origin: string): Promise<Blob> => {
  const canvas = document.createElement("canvas")
  canvas.width = STORY.width
  canvas.height = STORY.height
  const context = canvas.getContext("2d")!
  const link = `${origin}${pinPath(event.id)}`
  const margin = 90
  const width = STORY.width - 2 * margin
  const font = (weight: number, size: number) => context.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`

  context.fillStyle = SURFACE.light
  context.fillRect(0, 0, STORY.width, STORY.height)
  context.fillStyle = INK
  context.textBaseline = "top"

  let y = SAFE + 60
  font(500, 40)
  context.fillStyle = MUTED
  context.fillText("not", margin, y)
  font(800, 40)
  context.fillStyle = INK
  context.fillText("unh", margin + context.measureText("not").width - 6, y)
  y += 110

  font(800, 88)
  for (const line of wrapped(context, event.title, width, 3)) {
    context.fillText(line, margin, y)
    y += 100
  }
  y += 30

  font(600, 52)
  const timing = isUnset(event) ? "Time to pick" : `${when.format(event.start)} · ${clock.format(event.start)}`
  context.fillText(timing, margin, y)
  y += 76
  context.fillStyle = MUTED
  font(500, 48)
  for (const line of wrapped(context, whereOf(event), width, 2)) {
    context.fillText(line, margin, y)
    y += 62
  }

  // The code and link in the lower safe area, above the reply bar
  const code = 440
  const bottom = STORY.height - SAFE - 60
  drawCode(context, link, (STORY.width - code) / 2, bottom - code - 90, code)
  font(500, 40)
  context.fillStyle = INK
  context.textAlign = "center"
  context.fillText(link.replace(/^https?:\/\//, ""), STORY.width / 2, bottom - 60)

  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The image couldn't be made")), "image/png"))
}

/**
 * Shares an event as its story image, with its link on the clipboard: through the share sheet where files can be
 * shared, else as a download. Says which happened, for the UI to explain
 */
export const share = async (event: Event | Pin, origin: string): Promise<"shared" | "downloaded"> => {
  const blob = await storyImage(event, origin)
  const link = `${origin}${pinPath(event.id)}`
  await navigator.clipboard?.writeText(link).catch(() => {})
  const file = new File([blob], `${event.id}.png`, { type: "image/png" })
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share?.({ files: [file] })
    return "shared"
  }
  const anchor = document.createElement("a")
  anchor.href = URL.createObjectURL(blob)
  anchor.download = file.name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(anchor.href), 60_000)
  return "downloaded"
}
