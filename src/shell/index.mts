// What every page of the app starts with: the shared styles, the lifecycle (a fresh start after a long while away),
// the question of usage stats, keeping your things with the Worker, the way back to the map from a page it led to, and
// the service worker in production builds

import "./base.css"
import "./lifecycle.mts"
import "./usage.tsx"
import { startSync } from "./sync.mts"

startSync()

if (import.meta.env.PROD && "serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js")

// A page's way back to the map (PageHead in ui.tsx) is Back itself where this visit came from the map, so the sheet is
// as it was left, its page, its scroll and the camera; reached any other way, it's the link it says
addEventListener("click", event => {
  const back = event.target instanceof Element ? event.target.closest("a[data-back]") : null
  if (back && document.referrer.startsWith(`${location.origin}/map/`) && history.length > 1) {
    event.preventDefault()
    history.back()
  }
})
