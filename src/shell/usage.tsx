/** @jsxImportSource bruh/browser */

// Usage stats: which pages and features get used, counted with PostHog, which keeps them for notunh alone, and only
// once someone has said yes. Until then nothing of PostHog's is loaded. A browser sending Global Privacy Control has
// said no already, so it's never asked. The choice is remembered here, and changed on the home page.
//
// What's sent is kept to what says how notunh is used: pageviews, by path alone, since a query or fragment can hold
// a search or a place, and the events capture() is given. PostHog's lookup of a place from the IP address is off,
// and nothing identifies anyone: each browser is a random id. Session recording, autocapture, surveys, and the rest
// stay off, as does loading anything more from PostHog's CDN, so turning one on is a choice made here. Only
// notunh.app sends, so development, tests, and Previews never do

import { r, watch } from "bruh/reactive"
import type { PostHog, Properties } from "posthog-js"
import { remembered } from "./state.mts"

const KEY  = "phc_njs4dSMky9yGPMKUuiUSm63Et8QjT6M2hZspGT6Kofct"
const HOST = "https://us.i.posthog.com"

export type Choice = "yes" | "no"

/** Whether the browser asks sites not to share what it does, which counts as no */
export const isPrivate = (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true

/** What was chosen, or undefined while it hasn't been */
export const choice = remembered<Choice | undefined>("usage", stored => stored === "yes" || stored === "no" ? stored : undefined)

const isSending = location.hostname === "notunh.app"

/** A URL without its query or fragment */
const pathOf = (url: unknown) => {
  if (typeof url !== "string")
    return url
  try {
    const { origin, pathname } = new URL(url)
    return origin + pathname
  }
  catch {
    return undefined
  }
}

let posthog: Promise<PostHog> | undefined

const start = () =>
  posthog ??= import("posthog-js").then(({ default: posthog }) => {
    posthog.init(KEY, {
      api_host:                            HOST,
      defaults:                            "2026-08-30",
      persistence:                         "localStorage",
      person_profiles:                     "identified_only",
      autocapture:                         false,
      capture_dead_clicks:                 false,
      capture_exceptions:                  false,
      capture_heatmaps:                    false,
      capture_performance:                 false,
      disable_session_recording:           true,
      disable_surveys:                     true,
      disable_product_tours:               true,
      disable_conversations:               true,
      disable_web_experiments:             true,
      disable_external_dependency_loading: true,
      advanced_disable_feature_flags:      true,
      before_send: event => {
        if (event?.properties)
          for (const key of ["$current_url", "$referrer", "$initial_referrer", "$prev_pageview_url"])
            if (key in event.properties)
              event.properties[key] = pathOf(event.properties[key])
        return event
      }
    })
    // Every event skips PostHog's lookup of a place from the IP address
    posthog.register({ $geoip_disable: true })
    return posthog
  })

/** Counts an event, if the choice was yes. Its properties must say nothing of where someone is or what they search */
export const capture = (event: string, properties?: Properties) => {
  if (posthog)
    void posthog.then(posthog => posthog.capture(event, properties))
}

watch([choice], () => {
  if (!isSending || isPrivate)
    return
  if (choice.value === "yes")
    void start().then(posthog => posthog.opt_in_capturing())
  // Saying no after yes stops it, and forgets the random id
  else if (posthog)
    void posthog.then(posthog => {
      posthog.opt_out_capturing()
      posthog.reset()
    })
})

// Asked once, on whichever page someone opens first, without getting in the way of it
document.body.append(
  <div class="usage-prompt-slot">
    {r(() => !choice.value && !isPrivate &&
      <aside class="usage-prompt" aria-label="Usage stats">
        <p>
          <strong>Help make notunh better?</strong>
          Let it count which pages and features you use, so we know what to work on. Never your location, never
          anything that says who you are, and never sold or used for ads. You can change this on the home page.
        </p>
        <div class="actions">
          <button class="button" type="button" onclick={() => choice.value = "no"}>No thanks</button>
          <button class="button primary" type="button" onclick={() => choice.value = "yes"}>Sure</button>
        </div>
      </aside>
    )}
  </div>
)
