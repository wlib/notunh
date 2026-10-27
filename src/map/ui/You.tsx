/** @jsxImportSource bruh/browser */

// You, a page from the button in the search: what's yours, and who this device is to the Worker. My courses, the
// sections saved as a week and a list (Courses.tsx); a UNH email, verified by a code, which lets you list events on
// everyone's map, and gets your things back on a device that's lost them; and your devices, linked by a code one
// shows and another approves, which shares one identity, and your things (src/shell/sync.mts), between them. A code
// emailed is typed back, or the email's link opens here with a Confirm button, which is what consumes it, so a mail
// filter opening the link can't. Nothing here is required for anything else

import { r } from "bruh/reactive"
import * as api from "../../social/browser/api.mts"
import { LINK_TTL, linkUrl, parseCode, shown } from "../../social/link.mts"
import { encode, pathOf } from "../../social/qr.mts"
import { capture } from "../../shell/usage.tsx"
import { sync } from "../../shell/sync.mts"
import { MyCourses } from "./Courses.tsx"
import { Head } from "./Pages.tsx"

/** The UNH address verified for this device's person, once known, or null for none */
export const verified = r<string | null>(null)

/** How often a device showing a code asks whether it's been approved */
const POLL_MS = 2000

/** What the page's fragment asked for: approving a code shown elsewhere, or confirming an emailed code */
const asked = (() => {
  const hash = new URLSearchParams(location.hash.slice(1))
  const link = hash.get("link")
  const verify = hash.get("verify")
  if (link || verify)
    history.replaceState(history.state, "", location.pathname + location.search)
  if (link)
    return { kind: "link" as const, code: parseCode(link) }
  const [address, code] = verify?.split(":") ?? []
  return address && code ? { kind: "verify" as const, address, code } : undefined
})()

/** Asks the Worker which address this device's person has verified */
const refreshVerified = () =>
  void api.me().then(me => verified.value = me?.verified ?? null, () => {})

refreshVerified()

/** Linking merges both devices' people, either way round, so either side takes the other's things and address */
const takeMerged = () => {
  void sync()
  refreshVerified()
}

/** A code as a QR of its link, drawn as an SVG, and in letters */
const Code = ({ code }: { code: string }) => {
  const matrix = encode(linkUrl(location.origin, code))
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", `-2 -2 ${matrix.size + 4} ${matrix.size + 4}`)
  svg.setAttribute("shape-rendering", "crispEdges")
  svg.setAttribute("role", "img")
  svg.setAttribute("aria-label", `QR code for ${shown(code)}`)
  svg.innerHTML = `<rect x="-2" y="-2" width="${matrix.size + 4}" height="${matrix.size + 4}" fill="white"/><path d="${pathOf(matrix)}" fill="#23262e"/>`
  return (
    <div class="link-code">
      {svg}
      <strong class="code">{shown(code)}</strong>
    </div>
  )
}

/** Linking this device: show a code for another to approve, or approve a code another shows */
const Devices = () => {
  const code = r<string>()
  const standing = r<string>()
  const typed = r(asked?.kind === "link" ? asked.code ?? "" : "")
  let timer: ReturnType<typeof setInterval> | undefined
  /** Asks whether the code shown has been approved: every so often, and at once on coming back to this page, as from approving it on the other device */
  let check: (() => void) | undefined

  const stop = () => {
    clearInterval(timer)
    timer = undefined
    if (check)
      removeEventListener("focus", check)
    check = undefined
  }

  const show = () => {
    standing.value = undefined
    api.linkCode().then(({ code: made, expires }) => {
      code.value = made
      stop()
      check = () => api.linked(made).then(answer => {
        if (answer?.linked) {
          stop()
          code.value = undefined
          standing.value = "Linked."
          capture("device_linked")
          takeMerged()
        }
        else if (!answer || Date.now() > expires) {
          stop()
          code.value = undefined
          standing.value = "The code expired."
        }
      }, () => {})
      timer = setInterval(check, POLL_MS)
      addEventListener("focus", check)
    }, (error: Error) => standing.value = error.message)
  }

  const approve = () => {
    const parsed = parseCode(typed.peek())
    if (!parsed)
      return standing.value = "A code is eight letters and digits."
    api.approve(parsed).then(
      () => {
        standing.value = "Approved."
        typed.value = ""
        capture("device_approved")
        takeMerged()
      },
      (error: Error) => standing.value = error.message
    )
  }

  const input: HTMLInputElement = <input type="text" inputmode="text" autocapitalize="characters" autocomplete="off" spellcheck={false} placeholder="ABCD-EFGH" aria-label="Code from another device" value={typed.peek()} oninput={() => typed.value = input.value} />

  return (
    <section class="you-section">
      <h3 class="eyebrow">Devices</h3>
      <p class="muted">On a new device, show a code and approve it from one you already use, within {LINK_TTL / 60_000} minutes.</p>
      {r(() => code.value
        ? <>
            <Code code={code.value} />
            <p class="muted">Scan it with your other device, or type the code there.</p>
          </>
        : <button type="button" class="button" onclick={show}>Show a code on this device</button>
      )}
      <div class="field-row">
        {input}
        <button type="button" class="button" onclick={approve}>Approve</button>
      </div>
      {r(() => standing.value && <p class="notice" role="status">{standing.value}</p>)}
    </section>
  )
}

/** Verifying a UNH address: a code is emailed, and typed back or confirmed from the email's link */
const Email = () => {
  const address = r(asked?.kind === "verify" ? asked.address : "")
  const code = r(asked?.kind === "verify" ? asked.code : "")
  const isSent = r(asked?.kind === "verify")
  const isSending = r(false)
  const standing = r<string>()

  // Sending takes the Worker a few seconds, so the button says so meanwhile rather than seeming to need another tap
  const send = () => {
    if (isSending.peek())
      return
    isSending.value = true
    standing.value = undefined
    api.sendCode(address.peek()).then(
      () => {
        isSent.value = true
        standing.value = `Code sent to ${address.peek()}. Check your inbox and spam.`
      },
      (error: Error) => standing.value = error.message
    ).finally(() => isSending.value = false)
  }

  const confirm = () => {
    api.verify(address.peek(), code.peek()).then(
      ({ verified: done, joined }) => {
        verified.value = done
        standing.value = joined ? "Your things are back." : undefined
        capture("email_verified")
        void sync()
      },
      (error: Error) => standing.value = error.message
    )
  }

  const addressInput: HTMLInputElement = <input type="email" inputmode="email" autocomplete="email" placeholder="you@unh.edu" aria-label="UNH email" value={address.peek()} oninput={() => address.value = addressInput.value} />
  const codeInput: HTMLInputElement = <input type="text" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}" placeholder="6-digit code" aria-label="Code from the email" value={code.peek()} oninput={() => code.value = codeInput.value} />

  return (
    <section class="you-section">
      <h3 class="eyebrow">UNH email</h3>
      {r(() => verified.value
        ? <p>Verified as <strong>{verified.value}</strong>.</p>
        : <>
            <p class="muted">To post events for everyone, or get your things back on a new device.</p>
            <div class="field-row">
              {addressInput}
              <button type="button" class="button" onclick={send} disabled={isSending}>{r(() => isSending.value ? "Sending…" : isSent.value ? "Send again" : "Send code")}</button>
            </div>
            {r(() => isSent.value &&
              <div class="field-row">
                {codeInput}
                <button type="button" class="button primary" onclick={confirm}>Confirm</button>
              </div>
            )}
          </>
      )}
      {r(() => standing.value && <p class="notice" role="status">{standing.value}</p>)}
    </section>
  )
}

/** You: this device, your courses, your UNH email, and your devices */
export const YouView = () => <>
  <Head title="You" />
  <p class="view-facts">{r(() => verified.value ? <>This device · <strong>{verified.value}</strong></> : "This device · no account")}</p>
  <MyCourses />
  <Email />
  <Devices />
</>

/** Whether the page opened to approve or confirm something, which You should show at once */
export const isAsked = asked !== undefined
