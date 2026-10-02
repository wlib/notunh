// The panel as a bottom sheet on phones, at one of three heights to drag or tap between: down to just its header
// to leave the map, about half the screen, or taller for long directions. It's also lifted above the on-screen
// keyboard, which iOS draws over the page rather than making room for
//
// It only ever moves by translate, which the compositor handles on its own: while dragged or sliding between
// detents its box is the taller of the heights involved, slid down to show the right amount, and once still the
// box is swapped for the detent's own height in a single frame, so no frame has to lay out or paint its content

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

/** How far down an element's translate currently has it, mid-transition included */
const translated = (element: Element) => parseFloat(getComputedStyle(element).translate.split(" ")[1] ?? "0")

export const makeSheet = (panel: HTMLElement, grabber: HTMLElement, header: HTMLElement) => {
  const app = panel.parentElement!
  /** px of the screen's bottom the keyboard covers */
  let keyboard = 0
  /** px the content is translated down by, to stay put on screen while the box around it grows or shrinks */
  let shift = 0

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
    header.offsetTop + header.offsetHeight + parseFloat(getComputedStyle(panel).paddingBottom)

  /** Where the sheet's bottom edge sits, above the keyboard */
  const floor = () => app.getBoundingClientRect().bottom - keyboard
  /** The box's height, to the fraction of a px that offsetHeight rounds away */
  const box = () => panel.getBoundingClientRect().height

  const set = (name: string, value: number) => panel.style.setProperty(name, px(value))
  // Every child's style depends on the shift, so it's only touched when it changes
  const shiftTo = (value: number) => {
    if (value !== shift)
      set("--sheet-shift", shift = value)
  }

  // The grabber only shows when the panel is a sheet
  const isSheet = () => grabber.offsetParent !== null

  /** Lays the sheet out at rest for its detent: a box of that height, which only lowered keeps a translate on */
  const rest = () => {
    if (!isSheet())
      return
    const { half, tall } = caps()
    const lowered = detent.peek() === "lowered"
    const scroll = lowered ? 0 : panel.scrollTop - shift
    panel.classList.remove("moving")
    set("--sheet-max", detent.peek() === "tall" ? tall : half)
    shiftTo(0)
    panel.scrollTop = scroll
    set("--sheet-drop", lowered ? Math.max(0, box() - loweredExtent()) : 0)
  }

  /** Slides to the detent from wherever the sheet is now, mid-slide included, and rests once there */
  const move = () => {
    if (!isSheet())
      return
    const { half, tall } = caps()
    const to = detent.peek()
    const content = panel.scrollHeight
    const from = floor() - panel.getBoundingClientRect().top
    const cap = to === "lowered" ? loweredExtent() : to === "tall" ? tall : half
    // Where the content is on screen, as the scroll position that would put it there
    const scrolled = panel.scrollTop - translated(header)
    panel.classList.remove("moving")
    set("--sheet-max", Math.max(from, cap))
    const height = box()
    const scroll = panel.scrollTop
    // The box is as tall as either end of the slide, so the shorter end is the cap unless the content is shorter
    const extent = to === "lowered" ? cap : Math.min(height, cap)
    set("--sheet-drop", height - from)
    shiftTo(scroll - scrolled)
    // Flushed, so the slide starts from here rather than from where the last one was headed
    void panel.offsetHeight
    panel.classList.add("moving")
    set("--sheet-drop", height - extent)
    // The content stays where it is unless the box can't hold that scroll position, as when it shows more
    shiftTo(scroll - (to === "lowered" ? 0 : Math.min(scrolled, content - extent)))
    // A slide that's cut short or retargeted rejects, and the one that replaces it rests instead
    Promise.all(panel.getAnimations().map(animation => animation.finished)).then(rest, () => {})
  }

  /** Fits the sheet to new room: a slide in flight is retargeted, and at rest it's instant */
  const settle = () => panel.classList.contains("moving") ? move() : rest()

  watch([detent], () => {
    panel.classList.toggle("lowered", detent.value === "lowered")
    grabber.setAttribute("aria-label", detent.value === "lowered" ? "Raise the panel" : "Lower the panel")
    move()
  })
  // The sheet's own slides resize it too, and rest after them anyway
  const resized = new ResizeObserver(() => {
    if (!drag && !panel.classList.contains("moving"))
      rest()
  })
  for (const element of [app, panel, header])
    resized.observe(element)

  // Anything taking focus in the sheet, like a field, needs it up
  panel.addEventListener("focusin", raise)

  // Dragged by the grabber or the header, apart from what's tappable in it, as a height between lowered and tall
  let drag: {
    y: number, from: number, extent: number, at: number, velocity: number,
    box: number, scroll: number, scrolled: number, content: number, lowered: number, half: number, tall: number
  } | undefined

  const show = (extent: number) => {
    const { box, scroll, scrolled, content, lowered, tall } = drag!
    const clamped = Math.min(tall, Math.max(lowered, extent))
    set("--sheet-drop", box - clamped)
    shiftTo(scroll - Math.min(scrolled, content - clamped))
    return clamped
  }

  panel.addEventListener("pointerdown", event => {
    const target = event.target as Element
    if (!isSheet() || !target.closest(".grabber, .panel-header") || target.closest("a, input, button:not(.grabber)"))
      return
    const { half, tall } = caps()
    const content = panel.scrollHeight
    const from = floor() - panel.getBoundingClientRect().top
    const scrolled = panel.scrollTop - translated(header)
    panel.classList.remove("moving")
    set("--sheet-max", Math.max(half, tall))
    const height = box()
    drag = {
      y: event.clientY,
      from,
      extent: from,
      at: event.timeStamp,
      velocity: 0,
      box: height,
      scroll: panel.scrollTop,
      scrolled,
      content,
      lowered: loweredExtent(),
      half: Math.min(content, half),
      tall: height
    }
    show(from)
    panel.setPointerCapture(event.pointerId)
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

    const current = detent.peek()
    let next = current
    if (event.type !== "pointercancel" && Math.abs(extent - from) < SLOP)
      next = current === "lowered" ? "half" : "lowered"
    else if (event.type !== "pointercancel") {
      // The nearest height to where it's headed, with half winning when the content isn't long enough to be taller
      const headed = extent + velocity * FLICK_MS
      const heights: [Detent, number][] = [["half", half], ["lowered", lowered], ["tall", tall]]
      next = heights.reduce((a, b) => Math.abs(b[1] - headed) < Math.abs(a[1] - headed) ? b : a)[0]
    }
    // A new detent slides there when it's watched, so only staying put needs the slide back
    if (next === current)
      move()
    else
      detent.value = next
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
      set("--keyboard", keyboard)
      settle()
    }
    // Once per frame, as the viewport reports every step of the keyboard or toolbar animating, and focus has
    // only settled on its new element once its events are over
    let lifting = 0
    const liftLater = () => {
      cancelAnimationFrame(lifting)
      lifting = requestAnimationFrame(lift)
    }
    viewport.addEventListener("resize", liftLater)
    viewport.addEventListener("scroll", liftLater)
    document.addEventListener("focusin", liftLater)
    document.addEventListener("focusout", liftLater)
  }
}
