// The panel as a bottom sheet on phones, at one of three heights to drag or tap between: down to just its header to
// leave the map, about half the screen, or taller for long directions. It's also lifted above the on-screen keyboard,
// which iOS draws over the page rather than making room for, and the page kept from scrolling under it
//
// Each detent is a height of its own, whatever the page shown: what's in the sheet never sizes it, so going from a
// long page to a short one, a field's suggestions coming and going, or a trip being planned leaves it where it was.
// Only a drag, the grabber, or something new asking a lowered sheet up moves it
//
// Its grabber and header stay put; only the body below them scrolls. Dragging and scrolling are one motion, as a
// phone's own sheets have them: below tall, a pull anywhere moves the sheet, and a pull up that reaches tall runs on
// into scrolling the body; at tall, the body scrolls as ever when pulled up, and pulled down it's taken back to its
// top and the sheet comes down after, in the one pull. Its first move decides whose a touch is (owner in
// src/map/detents.mts), as the browser would otherwise scroll the body and take the touch for good. A pull up at tall
// is left to the browser, which scrolls it as it does anything, with its own momentum; a pull the sheet owns moves the
// scroll position itself, and flung, carries on by itself. Let go, it lands as src/map/detents.mts says: a flick goes
// on one detent, else the nearest
//
// It only ever moves by translate, which the compositor handles on its own. While dragged or sliding between detents,
// its box is the taller of the heights involved, slid down to show the right amount. Once still, the box is swapped
// for the detent's own height in a single frame, so no frame of the motion has to lay out or paint its content
//
// What it shows can be scrolled to a position before it's long enough to be there, as a page returned to loads what it
// lists, and is scrolled there as it grows, unless it's touched first

import { r, watch } from "bruh/reactive"
import { type Detent, type Owner, landing, owner, placed, releaseVelocity, travelOf } from "../detents.mts"

// The sheet's alone: everything else asks for what it wants of it below
const detent = r<Detent>("half")

/** Brings a lowered sheet back up, for something new in it to show */
export const raise = () => {
  if (detent.peek() === "lowered")
    detent.value = "half"
}

/** Takes the sheet as tall as it goes, for a view that wants the room */
export const expand = () => {
  detent.value = "tall"
}

/** Lowers the sheet to its header, or brings it back up: what the grabber does */
const toggle = () => {
  detent.value = detent.peek() === "lowered" ? "half" : "lowered"
}

// px, less movement than this is a tap
const SLOP = 6
// rem of the map always left above a tall sheet
const MAP_LEFT = 4
// How long a scroll position asked for waits for the content to grow long enough to reach it
const REACH_MS = 3000
// What a flung scroll keeps of its speed each ms, as a phone's own lists slow
const DECAY = 0.998
// px/ms, slower than which a flung scroll has stopped
const STOPPED = 0.02

const px = (value: number) => `${value}px`

/** How far down an element's translate currently has it, mid-transition included */
const translated = (element: Element) => parseFloat(getComputedStyle(element).translate.split(" ")[1] ?? "0")

/**
 * The sheet, of the panel, its grabber and header, which stay put, and its body, which scrolls, holding the content
 * as its one child
 */
export const makeSheet = (panel: HTMLElement, grabber: HTMLElement, header: HTMLElement, body: HTMLElement) => {
  const app = panel.parentElement!
  const content = body.firstElementChild as HTMLElement
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

  /** px of the panel that show when lowered: its header, and the room below that clears the home indicator */
  const loweredExtent = () =>
    header.offsetTop + header.offsetHeight + parseFloat(getComputedStyle(body).paddingBottom)

  /** Where the sheet's bottom edge sits, above the keyboard */
  const floor = () => app.getBoundingClientRect().bottom - keyboard
  /** How much of the sheet shows now, mid-motion included */
  const extentNow = () => floor() - panel.getBoundingClientRect().top
  /** The box's height, to the fraction of a px that offsetHeight rounds away */
  const box = () => panel.getBoundingClientRect().height
  /** How far the body can scroll */
  const maxScroll = () => Math.max(0, body.scrollHeight - body.clientHeight)

  const set = (name: string, value: number) => panel.style.setProperty(name, px(value))
  // Every child's style depends on the shift, so it's only touched when it changes
  const shiftTo = (value: number) => {
    if (value !== shift)
      set("--sheet-shift", shift = value)
  }

  // The grabber only shows when the panel is a sheet
  const isSheet = () => grabber.offsetParent !== null

  /** A field to bring into sight once the sheet's at rest, as the keyboard has come up under it */
  let reveal: Element | undefined
  const revealField = () => {
    reveal?.scrollIntoView({ block: "nearest" })
    reveal = undefined
  }

  /** Lays the sheet out at rest for its detent: a box of that height, which only lowered keeps a translate on */
  const rest = () => {
    if (!isSheet())
      return
    const { half, tall } = caps()
    const lowered = detent.peek() === "lowered"
    const scroll = lowered ? 0 : body.scrollTop - shift
    panel.classList.remove("moving")
    set("--sheet-max", detent.peek() === "tall" ? tall : half)
    shiftTo(0)
    body.scrollTop = scroll
    set("--sheet-drop", lowered ? Math.max(0, box() - loweredExtent()) : 0)
    revealField()
  }

  /** Slides to the detent from wherever the sheet is now, mid-slide included, and rests once there */
  const move = () => {
    if (!isSheet())
      return
    const { half, tall } = caps()
    const to = detent.peek()
    const length = body.scrollHeight
    const from = extentNow()
    const cap = to === "lowered" ? loweredExtent() : to === "tall" ? tall : half
    // Where the content is on screen, as the scroll position that would put it there
    const scrolled = body.scrollTop - translated(content)
    panel.classList.remove("moving")
    set("--sheet-max", Math.max(from, cap))
    const height = box()
    const scroll = body.scrollTop
    // The box is as tall as either end of the slide
    const extent = Math.min(height, cap)
    set("--sheet-drop", height - from)
    shiftTo(scroll - scrolled)
    // Flushed, so the slide starts from here rather than from where the last one was headed
    void panel.offsetHeight
    panel.classList.add("moving")
    set("--sheet-drop", height - extent)
    // The content stays where it is unless the box can't hold that scroll position, as when it shows more
    shiftTo(scroll - (to === "lowered" ? 0 : Math.min(scrolled, length - (extent - body.offsetTop))))
    // A slide that's cut short or retargeted rejects, and the one that replaces it rests instead
    Promise.all(panel.getAnimations().map(animation => animation.finished)).then(rest, () => {})
  }

  /** Fits the sheet to new room: a slide in flight is retargeted, and at rest it's instant */
  const settle = () => panel.classList.contains("moving") ? move() : rest()

  /** px the content is scrolled down, mid-slide too */
  const scrolled = () => body.scrollTop - shift

  /** A scroll position asked for, until the content's scrolled there or it's given up on */
  let wanted: { top: number, until: number } | undefined
  const reach = () => {
    if (wanted && performance.now() > wanted.until)
      wanted = undefined
    if (!wanted)
      return
    body.scrollTop = wanted.top + shift
    // A fraction of a px short is there
    if (scrolled() > wanted.top - 1)
      wanted = undefined
  }
  /** Scrolls the content to a position, now if it's long enough, else as it grows */
  const scrollTo = (top: number) => {
    wanted = { top, until: performance.now() + REACH_MS }
    reach()
  }

  /** A scroll flung by a drag the sheet owned, carrying on by itself as a phone's own lists do, slowing until it stops */
  let flinging = 0
  const fling = (velocity: number) => {
    let speed = velocity
    let top = body.scrollTop
    let last = performance.now()
    const step = (now: number) => {
      const elapsed = now - last
      last = now
      top += speed * elapsed
      speed *= DECAY ** elapsed
      body.scrollTop = top
      if (Math.abs(speed) > STOPPED && top > 0 && top < maxScroll())
        flinging = requestAnimationFrame(step)
    }
    flinging = requestAnimationFrame(step)
  }
  // Anything else moving the content takes over from a scroll asked for or flung
  for (const type of ["pointerdown", "wheel", "keydown"])
    panel.addEventListener(type, () => {
      wanted = undefined
      cancelAnimationFrame(flinging)
    }, { passive: true })

  watch([detent], () => {
    panel.classList.toggle("lowered", detent.value === "lowered")
    grabber.setAttribute("aria-label", detent.value === "lowered" ? "Raise the panel" : "Lower the panel")
    move()
  })
  // The room it has changing sets it at its detent again, and what it shows changing size is scrolled on to where
  // that was asked to be. The sheet's own slides resize it too, and rest after them anyway
  const resized = new ResizeObserver(() => {
    if (!drag && !panel.classList.contains("moving"))
      rest()
    reach()
  })
  for (const element of [app, panel, header, content])
    resized.observe(element)

  // Anything taking focus in the sheet, like a field, needs it up
  panel.addEventListener("focusin", raise)
  // The header draws a line under itself once the body has scrolled beneath it
  body.addEventListener("scroll", () => panel.classList.toggle("scrolled", body.scrollTop > 0), { passive: true })

  // Dragged to any height between lowered and tall, and on into scrolling the body, by the grabber or the header, or
  // by the content when its first move makes the touch the sheet's. Tapping the grabber or the header toggles it,
  // and taps on anything else are left alone. A touch only becomes a drag once it's moved, so a tap changes nothing
  // about the sheet, and a field never starts one: what it opens, a keyboard or a picker, is placed by where the
  // field is as it's touched
  let touched: { x: number, y: number, at: number, isHandle: boolean, owner?: Owner } | undefined
  /**
   * A drag in hand: the finger's last y and when, how fast its travel is changing, and the sheet as the drag found
   * it, laid out in a box as tall as tall, with its travel from there and its furthest (travelOf in detents.mts)
   */
  let drag: {
    y: number, at: number, velocity: number, travel: number, visible: number,
    box: number, base: number, most: number, maxScroll: number, lowered: number, half: number, tall: number
  } | undefined

  /** Shows the sheet and its content at a travel, kept within the drag's, and says where that was kept */
  const show = (travel: number) => {
    const held = drag!
    held.travel = Math.min(held.most, Math.max(held.lowered, travel))
    const { extent, scrollTop } = placed(held, held.travel, held.base, held.maxScroll)
    set("--sheet-drop", held.box - extent)
    // The content shows no further down than its end, scrolled no further than fills what shows of the body, and the
    // box being taller than that shows, the browser may hold it short of there, which the shift makes up
    const visible = Math.min(scrollTop, Math.max(0, body.scrollHeight - (extent - body.offsetTop)))
    if (visible !== held.visible)
      body.scrollTop = held.visible = visible
    shiftTo(body.scrollTop - visible)
    return held.travel
  }

  /**
   * Takes the sheet up from where it is, laid out to move anywhere between lowered and tall and, by its content, to
   * scroll on past it; by its handle it goes no further than tall, and leaves the content scrolled as it is
   */
  const grab = (y: number, at: number, isHandle: boolean) => {
    const { half, tall } = caps()
    const extent = extentNow()
    const scrolled = body.scrollTop - translated(content)
    panel.classList.remove("moving")
    // A mouse dragging by the content would select text along the way
    panel.classList.add("dragging")
    getSelection()?.removeAllRanges()
    set("--sheet-max", Math.max(half, tall))
    const height = box()
    const lowered = loweredExtent()
    const most = maxScroll()
    // At tall to the fraction of a px that a rect can be off by is at tall
    const { from, base, most: furthest } =
      isHandle ? { from: extent, base: scrolled, most: height } : travelOf({ lowered, tall: height }, extent >= height - 1 ? height : extent, scrolled, most)
    drag = { y, at, velocity: 0, travel: from, visible: NaN, box: height, base, most: furthest, maxScroll: most, lowered, half, tall: height }
    show(from)
    return drag
  }

  /**
   * Whose a touch on the content is, which its first move decides for good: the sheet's, or else the content's own,
   * which the browser scrolls as it would anything
   */
  const claim = (x: number, y: number) => {
    if (!touched || touched.owner)
      return
    const dx = x - touched.x
    const dy = y - touched.y
    if (dx === 0 && dy === 0)
      return
    const isTall = extentNow() >= caps().tall - 1
    const canScroll = body.scrollTop < maxScroll() - 1
    if (owner({ isTall, canScroll, dx, dy }) === "sheet")
      touched.owner = "sheet"
    else
      touched = undefined
  }

  panel.addEventListener("pointerdown", event => {
    // Another finger mid-drag changes nothing
    if (drag)
      return
    const target = event.target as Element
    touched = undefined
    // Fields keep the pointer, and a question asked does; so do buttons in the header, which is otherwise a handle
    if (!isSheet() || target.closest("input, textarea, select, dialog"))
      return
    const isHandle = target.closest(".grabber, .panel-header") !== null && !target.closest("button:not(.grabber)")
    touched = { x: event.clientX, y: event.clientY, at: event.timeStamp, isHandle, owner: isHandle ? "sheet" : undefined }
    // A handle holds the pointer from the start, so a drag up off the sheet still moves it; anything else only once
    // it's a drag, as a click goes to whatever holds the pointer when it's let go
    if (isHandle)
      panel.setPointerCapture(event.pointerId)
  })

  // The browser would scroll the content for a touch pulling it, and take the touch from the sheet to do so, so
  // one that's the sheet's is kept from it. Its first move, before pointermove has heard of it, may be the one
  // that claims it
  panel.addEventListener("touchmove", event => {
    const { clientX, clientY } = event.changedTouches[0]
    claim(clientX, clientY)
    if (drag || touched?.owner === "sheet")
      event.preventDefault()
  }, { passive: false })

  panel.addEventListener("pointermove", event => {
    claim(event.clientX, event.clientY)
    if (!touched)
      return
    if (!drag) {
      if (Math.abs(event.clientY - touched.y) < SLOP)
        return
      panel.setPointerCapture(event.pointerId)
    }
    // From where and when it was touched, so the first move's speed is over the time since, not an instant
    const held = drag ?? grab(touched.y, touched.at, touched.isHandle)
    const was = held.travel
    const travel = show(was + held.y - event.clientY)
    held.velocity = (travel - was) / Math.max(1, event.timeStamp - held.at)
    held.y = event.clientY
    held.at = event.timeStamp
  })

  const release = (event: PointerEvent) => {
    const wasTouched = touched
    touched = undefined
    if (!drag) {
      // A tap on the grabber or the header toggles it
      if (wasTouched?.isHandle && event.type === "pointerup")
        toggle()
      return
    }
    const { travel, at, lowered, half, tall } = drag
    const velocity = releaseVelocity(drag.velocity, event.timeStamp - at)
    drag = undefined
    panel.classList.remove("dragging")

    const current = detent.peek()
    // Let go in the body's scroll, the sheet is tall and the scroll carries on; else it lands among the detents
    const isScrolled = travel > tall
    const next = event.type === "pointercancel" ? current : isScrolled ? "tall" : landing({ lowered, half, tall }, travel, velocity)
    if (isScrolled && event.type !== "pointercancel")
      fling(velocity)
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
      toggle()
  })

  // The page never scrolls, but iOS scrolls it anyway to show a field the keyboard would cover, and can leave it
  // scrolled once the keyboard's gone, drawing everything fixed away from where its taps land. The sheet lifts the
  // field above the keyboard itself, so the page goes straight back
  addEventListener("scroll", () => {
    // Unless zoomed in, where panning about is what scrolls it
    if ((scrollX || scrollY) && (window.visualViewport?.scale ?? 1) <= 1)
      window.scrollTo(0, 0)
  }, { passive: true })

  // The keyboard covers the bottom of the layout viewport, by however much the visual viewport doesn't reach
  const viewport = window.visualViewport
  if (viewport) {
    const lift = () => {
      const isTyping = document.activeElement?.matches("input, textarea") ?? false
      const covered = isTyping ? Math.max(0, innerHeight - viewport.height - viewport.offsetTop) : 0
      const isNew = covered !== keyboard
      keyboard = covered
      set("--keyboard", keyboard)
      settle()
      // The field typed in, in sight above the keyboard once the sheet's at rest there, now or after its slide
      if (isNew && isTyping && panel.contains(document.activeElement))
        reveal = document.activeElement!
      if (!panel.classList.contains("moving"))
        revealField()
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
