/** @jsxImportSource bruh/browser */

// Usage stats, kept with PostHog for notunh alone: page views and errors for everyone, and, for those who say yes,
// which features get used and which places trips are planned between. events.mts decides what each event sends.
//
// Until someone says yes, PostHog runs cookieless: nothing is stored on the device, and PostHog tells visitors apart
// only by a hash of the day, IP address, and browser that it never keeps. Saying yes lets it remember this device in
// localStorage, never a cookie, which nothing on the server reads. Saying no after yes forgets it. A browser sending
// Global Privacy Control has said no already, so it's never asked. The choice is ours, remembered here before
// PostHog loads and changed on the home page, and PostHog's own consent follows it.
//
// PostHog loads after the page, from the page's own chunk, which its head names so the service worker keeps it
// offline (vite.config.mts). Only the extensions used are given to it, and nothing more loads from PostHog's CDN, so
// session recording, surveys, feature flags, heatmaps, and the rest stay off. Events made offline wait in posthog-js'
// memory and are sent once it's back online, unless the page is closed first. Only the origin the head names sends,
// so development, Previews, and tests never do (Head.tsx)

import { r, watch } from "bruh/reactive"
import type { PostHog, Properties } from "posthog-js/dist/module.slim.js"
import { remembered } from "./state.mts"
import { beforeSend } from "./events.mts"

const KEY = "phc_njs4dSMky9yGPMKUuiUSm63Et8QjT6M2hZspGT6Kofct"

export type Choice = "yes" | "no"

/** Whether the browser asks sites not to share what it does, which counts as no */
export const isPrivate = (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true

/** What was chosen, or undefined while it hasn't been */
export const choice = remembered<Choice | undefined>("usage", stored => stored === "yes" || stored === "no" ? stored : undefined)

const isYes = () =>
  !isPrivate && choice.peek() === "yes"

const isSending = document.querySelector<HTMLMetaElement>("meta[name=usage-origin]")?.content === location.origin

let posthog: Promise<PostHog> | undefined

const start = () =>
  posthog ??= Promise.all([
    import("posthog-js/dist/module.slim.js"),
    import("posthog-js/dist/extension-bundles.js"),
    // What the error and web vitals extensions would otherwise load from PostHog's CDN
    import("posthog-js/dist/exception-autocapture.js"),
    import("posthog-js/dist/web-vitals.js")
  ]).then(([{ default: posthog }, { AnalyticsExtensions: { autocapture, historyAutocapture, webVitalsAutocapture }, ErrorTrackingExtensions }]) => {
    posthog.init(KEY, {
      api_host:                            "https://us.i.posthog.com",
      ui_host:                             "https://us.posthog.com",
      defaults:                            "2026-08-30",
      __extensionClasses:                  { autocapture, historyAutocapture, webVitalsAutocapture, ...ErrorTrackingExtensions },
      cookieless_mode:                     "on_reject",
      opt_out_capturing_by_default:        true,
      persistence:                         "localStorage",
      person_profiles:                     "identified_only",
      // Clicks are counted by the kind of element alone, never by what it says or links to, like a place or a food
      mask_all_text:                       true,
      mask_all_element_attributes:         true,
      capture_exceptions:                  true,
      capture_performance:                 { web_vitals: true, web_vitals_attribution: false, network_timing: false },
      capture_heatmaps:                    false,
      capture_dead_clicks:                 false,
      disable_session_recording:           true,
      disable_surveys:                     true,
      disable_product_tours:               true,
      disable_conversations:               true,
      disable_web_experiments:             true,
      disable_external_dependency_loading: true,
      advanced_disable_flags:              true,
      before_send:                         beforeSend(isYes)
    })
    return posthog
  })

/** Brings PostHog's consent in line with the choice: opted in for yes, else cookieless with nothing of it kept */
const follow = (posthog: PostHog) => {
  const consent = posthog.get_explicit_consent_status()
  if (isYes())
    consent !== "granted" && posthog.opt_in_capturing({ captureEventName: false })
  else if (consent !== "pending") {
    posthog.opt_out_capturing()
    posthog.clear_opt_in_out_capturing()
  }
}

/** Counts a use of a feature, if the choice was yes. Its properties must say nothing of where someone is or what they search */
export const capture = (event: string, properties?: Properties) => {
  if (isSending && isYes())
    void start().then(posthog => posthog.capture(event, properties))
}

if (isSending)
  watch([choice], () => void start().then(follow))

// Asked once, on whichever page someone opens first, without getting in the way of it
document.body.append(
  <div class="usage-prompt-slot">
    {r(() => !choice.value && !isPrivate &&
      <aside class="usage-prompt" aria-label="Usage stats">
        <p>Let notunh collect non-identifying usage stats? <a href="/#usage">See details</a></p>
        <div class="actions">
          <button class="button" type="button" onclick={() => choice.value = "no"}>No</button>
          <button class="button primary" type="button" onclick={() => choice.value = "yes"}>Ok</button>
        </div>
      </aside>
    )}
  </div>
)
