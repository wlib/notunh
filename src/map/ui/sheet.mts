// The panel as a bottom sheet on phones: dragged or tapped down to just its header to leave more of the map,
// and lifted above the on-screen keyboard, which iOS draws over the page rather than making room for

import { r, watch } from "bruh/reactive"

/** Whether the sheet is down to just its header */
export const isLowered = r(false)

// px/ms, a release moving this fast goes the way it was moving
const FLICK = 0.4
// px, less movement than this is a tap
const SLOP = 6

export const makeSheet = (panel: HTMLElement, grabber: HTMLElement, header: HTMLElement) => {
  // How far down the sheet goes to leave its header showing, over the bottom padding that clears the home indicator
  let lowest = 0
  const measure = () => {
    const shown = header.getBoundingClientRect().bottom - panel.getBoundingClientRect().top + panel.scrollTop
    lowest = Math.max(0, panel.offsetHeight - shown - parseFloat(getComputedStyle(panel).paddingBottom))
    panel.style.setProperty("--lowest", `${lowest}px`)
  }
  const resized = new ResizeObserver(measure)
  resized.observe(panel)
  resized.observe(header)

  watch([isLowered], () => {
    panel.classList.toggle("lowered", isLowered.value)
    grabber.setAttribute("aria-expanded", isLowered.value ? "false" : "true")
    grabber.setAttribute("aria-label", isLowered.value ? "Raise the panel" : "Lower the panel")
    if (isLowered.value)
      panel.scrollTop = 0
  })

  // Anything taking focus in the sheet, like a field, needs it up
  panel.addEventListener("focusin", () => isLowered.value = false)

  // Dragged by the grabber or the header, apart from what's tappable in it
  let drag: { y: number, from: number, offset: number, at: number, velocity: number } | undefined
  panel.addEventListener("pointerdown", event => {
    const target = event.target as Element
    // The grabber only shows when the panel is a sheet
    const isSheet = grabber.offsetParent !== null
    if (!isSheet || !target.closest(".grabber, .panel-header") || target.closest("a, input, button:not(.grabber)"))
      return
    const from = isLowered.peek() ? lowest : 0
    drag = { y: event.clientY, from, offset: from, at: event.timeStamp, velocity: 0 }
    panel.setPointerCapture(event.pointerId)
    panel.classList.add("dragging")
  })
  panel.addEventListener("pointermove", event => {
    if (!drag)
      return
    const offset = Math.min(lowest, Math.max(0, drag.from + event.clientY - drag.y))
    drag.velocity = (offset - drag.offset) / Math.max(1, event.timeStamp - drag.at)
    drag.offset = offset
    drag.at = event.timeStamp
    panel.style.translate = `0 ${offset}px`
  })
  const release = (event: PointerEvent) => {
    if (!drag)
      return
    const { from, offset, velocity } = drag
    drag = undefined
    panel.classList.remove("dragging")
    panel.style.translate = ""
    isLowered.value =
      event.type === "pointercancel" ? isLowered.peek() :
      Math.abs(offset - from) < SLOP ? !isLowered.peek() :
      velocity > FLICK               ? true :
      velocity < -FLICK              ? false :
                                       offset > lowest / 2
  }
  panel.addEventListener("pointerup", release)
  panel.addEventListener("pointercancel", release)
  // Pointers toggle it on release, so a click only toggles from the keyboard
  grabber.addEventListener("click", event => {
    if (event.detail === 0)
      isLowered.value = !isLowered.peek()
  })

  // The keyboard covers the bottom of the layout viewport, by however much the visual viewport doesn't reach
  const viewport = window.visualViewport
  if (viewport) {
    const lift = () => {
      const isTyping = document.activeElement?.matches("input, textarea") ?? false
      const covered = isTyping ? innerHeight - viewport.height - viewport.offsetTop : 0
      panel.style.setProperty("--keyboard", `${Math.max(0, covered)}px`)
    }
    // Focus has only settled on its new element once its events are over
    const liftLater = () => requestAnimationFrame(lift)
    viewport.addEventListener("resize", lift)
    viewport.addEventListener("scroll", lift)
    document.addEventListener("focusin", liftLater)
    document.addEventListener("focusout", liftLater)
  }
}
