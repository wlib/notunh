// The panel as a bottom sheet on phones, at one of three heights to drag or tap between: down to just its header
// to leave the map, about half the screen, or taller for long directions. It's also lifted above the on-screen
// keyboard, which iOS draws over the page rather than making room for

import { r, watch } from "bruh/reactive"

export type Detent = "lowered" | "half" | "tall"

export const detent = r<Detent>("half")

/** Brings a lowered sheet back up, for something new in it to show */
export const raise = () => {
  if (detent.peek() === "lowered")
    detent.value = "half"
}

// How long a flick carries on at the speed it was let go, to judge where it's headed
const FLICK_MS = 150
// px, less movement than this is a tap
const SLOP = 6
// rem of the map always left above a tall sheet
const MAP_LEFT = 4

const px = (value: number) => `${value}px`

export const makeSheet = (panel: HTMLElement, grabber: HTMLElement, header: HTMLElement) => {
  const app = panel.parentElement!
  /** px of the screen's bottom the keyboard covers */
  let keyboard = 0

  /** The tallest the panel may be at half and tall, in px */
  const caps = () => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
    const room = app.clientHeight - keyboard - parseFloat(getComputedStyle(panel).getPropertyValue("--safe-top"))
    return {
      half: Math.min(app.clientHeight * 0.45, 40 * rem, room),
      tall: room - MAP_LEFT * rem
    }
  }

  /** px of the panel that show when lowered: its header, and the padding below that clears the home indicator */
  const loweredExtent = () =>
    header.getBoundingClientRect().bottom - panel.getBoundingClientRect().top + panel.scrollTop +
    parseFloat(getComputedStyle(panel).paddingBottom)

  const render = (max: number, drop: number) => {
    panel.style.setProperty("--sheet-max", px(max))
    panel.style.setProperty("--sheet-drop", px(drop))
  }

  // The grabber only shows when the panel is a sheet
  const isSheet = () => grabber.offsetParent !== null

  const settle = () => {
    if (!isSheet())
      return
    const { half, tall } = caps()
    if (detent.peek() !== "lowered")
      return render(detent.peek() === "tall" ? tall : half, 0)
    // Lowered from its half height, by however much of that isn't the header
    render(half, 0)
    render(half, Math.max(0, panel.offsetHeight - loweredExtent()))
  }

  watch([detent], () => {
    panel.classList.toggle("lowered", detent.value === "lowered")
    grabber.setAttribute("aria-label", detent.value === "lowered" ? "Raise the panel" : "Lower the panel")
    if (detent.value === "lowered")
      panel.scrollTop = 0
    settle()
  })
  const resized = new ResizeObserver(settle)
  for (const element of [app, panel, header])
    resized.observe(element)

  // Anything taking focus in the sheet, like a field, needs it up
  panel.addEventListener("focusin", raise)

  // Dragged by the grabber or the header, apart from what's tappable in it, as a height between lowered and tall
  let drag: {
    y: number, from: number, extent: number, at: number, velocity: number,
    lowered: number, half: number, tall: number, halfCap: number
  } | undefined

  const show = (extent: number) => {
    const { lowered, half, tall, halfCap } = drag!
    const clamped = Math.min(tall, Math.max(lowered, extent))
    if (clamped <= half)
      render(halfCap, half - clamped)
    else
      render(clamped, 0)
    return clamped
  }

  panel.addEventListener("pointerdown", event => {
    const target = event.target as Element
    if (!isSheet() || !target.closest(".grabber, .panel-header") || target.closest("a, input, button:not(.grabber)"))
      return
    const { half, tall } = caps()
    const content = panel.scrollHeight
    const from = panel.getBoundingClientRect().height - parseFloat(panel.style.getPropertyValue("--sheet-drop") || "0")
    drag = {
      y: event.clientY,
      from,
      extent: from,
      at: event.timeStamp,
      velocity: 0,
      lowered: loweredExtent(),
      half: Math.min(content, half),
      tall: Math.max(Math.min(content, half), Math.min(content, tall)),
      halfCap: half
    }
    panel.setPointerCapture(event.pointerId)
    panel.classList.add("dragging")
  })

  panel.addEventListener("pointermove", event => {
    if (!drag)
      return
    const extent = show(drag.from - (event.clientY - drag.y))
    drag.velocity = (extent - drag.extent) / Math.max(1, event.timeStamp - drag.at)
    drag.extent = extent
    drag.at = event.timeStamp
  })

  const release = (event: PointerEvent) => {
    if (!drag)
      return
    const { from, extent, velocity, lowered, half, tall } = drag
    drag = undefined
    panel.classList.remove("dragging")

    const current = detent.peek()
    if (event.type !== "pointercancel" && Math.abs(extent - from) < SLOP)
      detent.value = current === "lowered" ? "half" : "lowered"
    else if (event.type !== "pointercancel") {
      // The nearest height to where it's headed, with half winning when the content isn't long enough to be taller
      const headed = extent + velocity * FLICK_MS
      const heights: [Detent, number][] = [["half", half], ["lowered", lowered], ["tall", tall]]
      detent.value = heights.reduce((a, b) => Math.abs(b[1] - headed) < Math.abs(a[1] - headed) ? b : a)[0]
    }
    settle()
  }
  panel.addEventListener("pointerup", release)
  panel.addEventListener("pointercancel", release)

  // Pointers toggle it on release, so a click only toggles from the keyboard
  grabber.addEventListener("click", event => {
    if (event.detail === 0)
      detent.value = detent.peek() === "lowered" ? "half" : "lowered"
  })

  // The keyboard covers the bottom of the layout viewport, by however much the visual viewport doesn't reach
  const viewport = window.visualViewport
  if (viewport) {
    const lift = () => {
      const isTyping = document.activeElement?.matches("input, textarea") ?? false
      keyboard = isTyping ? Math.max(0, innerHeight - viewport.height - viewport.offsetTop) : 0
      panel.style.setProperty("--keyboard", px(keyboard))
      settle()
    }
    // Focus has only settled on its new element once its events are over
    const liftLater = () => requestAnimationFrame(lift)
    viewport.addEventListener("resize", lift)
    viewport.addEventListener("scroll", lift)
    document.addEventListener("focusin", liftLater)
    document.addEventListener("focusout", liftLater)
  }
}
