// The panel as a bottom sheet on phones, at one of three heights to drag or tap between: down to just its header to
// leave the map, about half the screen, or taller for long directions. It's also lifted above the on-screen keyboard,
// which iOS draws over the page rather than making room for
//
// Each detent is a height of its own, whatever the page shown: what's in the sheet never sizes it, so going from a
// long page to a short one, a field's suggestions coming and going, or a trip being planned leaves it where it was.
// Only a drag, the grabber, or something new asking a lowered sheet up moves it
//
// It only ever moves by translate, which the compositor handles on its own. While dragged or sliding between detents,
// its box is the taller of the heights involved, slid down to show the right amount. Once still, the box is swapped
// for the detent's own height in a single frame, so no frame of the motion has to lay out or paint its content
//
// What it shows can be scrolled to a position before it's long enough to be there, as a page returned to loads what it
// lists, and is scrolled there as it grows, unless it's touched first

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
// How long a scroll position asked for waits for the content to grow long enough to reach it
const REACH_MS = 3000

const px = (value: number) => `${value}px`

/** How far down an element's translate currently has it, mid-transition included */
const translated = (element: Element) => parseFloat(getComputedStyle(element).translate.split(" ")[1] ?? "0")

export const makeSheet = (panel: HTMLElement, grabber: HTMLElement, header: HTMLElement) => {
  const app = panel.parentElement!
  /** px of the screen's bottom the keyboard covers */
  let keyboard = 0
  /** px the content is translated down by, to stay put on screen while the box around it grows or shrinks */
  let shift = 0

  /** The panel's height at half and tall, in px, tall never under half, as the keyboard leaves less room */
  const caps = () => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
    const room = app.clientHeight - keyboard - parseFloat(getComputedStyle(panel).getPropertyValue("--safe-top"))
    const half = Math.min(app.clientHeight * 0.45, 40 * rem, room)
    return { half, tall: Math.max(half, room - MAP_LEFT * rem) }
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
    panel.classList.toggle("fits", panel.scrollHeight <= panel.clientHeight)
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
    // The box is as tall as either end of the slide
    const extent = Math.min(height, cap)
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

  /** px the content is scrolled down, mid-slide too */
  const scrolled = () => panel.scrollTop - shift

  /** A scroll position asked for, until the content's scrolled there or it's given up on */
  let wanted: { top: number, until: number } | undefined
  const reach = () => {
    if (wanted && performance.now() > wanted.until)
      wanted = undefined
    if (!wanted)
      return
    panel.scrollTop = wanted.top + shift
    // A fraction of a px short is there
    if (scrolled() > wanted.top - 1)
      wanted = undefined
  }
  /** Scrolls the content to a position, now if it's long enough, else as it grows */
  const scrollTo = (top: number) => {
    wanted = { top, until: performance.now() + REACH_MS }
    reach()
  }
  for (const type of ["pointerdown", "wheel", "keydown"])
    panel.addEventListener(type, () => wanted = undefined, { passive: true })

  watch([detent], () => {
    panel.classList.toggle("lowered", detent.value === "lowered")
    grabber.setAttribute("aria-label", detent.value === "lowered" ? "Raise the panel" : "Lower the panel")
    move()
  })
  // The room it has changing sets it at its detent again, and what it shows changing size only says whether there's
  // anything to scroll. The sheet's own slides resize it too, and rest after them anyway
  const resized = new ResizeObserver(() => {
    if (!drag && !panel.classList.contains("moving"))
      rest()
    reach()
  })
  for (const element of [app, panel, header])
    resized.observe(element)
  const observeShown = () => {
    for (const child of panel.children)
      resized.observe(child)
  }
  new MutationObserver(observeShown).observe(panel, { childList: true })
  observeShown()

  // Anything taking focus in the sheet, like a field, needs it up
  panel.addEventListener("focusin", raise)

  // Dragged to any height between lowered and tall, by the grabber or the header, or anywhere when there's nothing to
  // scroll. Tapping the grabber or the header toggles it, and taps on anything else are left alone
  let drag: {
    y: number, from: number, extent: number, at: number, velocity: number, isHandle: boolean,
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
    // Links and fields keep the pointer; so do buttons in the header, which is otherwise a handle
    if (!isSheet() || target.closest("a, input"))
      return
    const isHandle = target.closest(".grabber, .panel-header") !== null && !target.closest("button:not(.grabber)")
    if (!isHandle && !panel.classList.contains("fits"))
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
      isHandle,
      box: height,
      scroll: panel.scrollTop,
      scrolled,
      content,
      lowered: loweredExtent(),
      half,
      tall: height
    }
    show(from)
    // Anything else is only held once it's a drag, as a click goes to whatever holds the pointer when it's let go
    if (isHandle)
      panel.setPointerCapture(event.pointerId)
  })

  panel.addEventListener("pointermove", event => {
    if (!drag)
      return
    if (!panel.hasPointerCapture(event.pointerId)) {
      if (Math.abs(event.clientY - drag.y) < SLOP)
        return
      panel.setPointerCapture(event.pointerId)
    }
    const extent = show(drag.from - (event.clientY - drag.y))
    drag.velocity = (extent - drag.extent) / Math.max(1, event.timeStamp - drag.at)
    drag.extent = extent
    drag.at = event.timeStamp
  })

  const release = (event: PointerEvent) => {
    if (!drag)
      return
    const { from, extent, velocity, isHandle, lowered, half, tall } = drag
    drag = undefined

    const current = detent.peek()
    let next = current
    if (event.type !== "pointercancel") {
      if (Math.abs(extent - from) >= SLOP) {
        // The nearest height to where it's headed
        const headed = extent + velocity * FLICK_MS
        const heights: [Detent, number][] = [["half", half], ["lowered", lowered], ["tall", tall]]
        next = heights.reduce((a, b) => Math.abs(b[1] - headed) < Math.abs(a[1] - headed) ? b : a)[0]
      }
      else if (isHandle)
        next = current === "lowered" ? "half" : "lowered"
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

  return { scrolled, scrollTo }
}
