// What every page of the app starts with: the shared styles, a fresh start after a long while away, and offline
// support once built

import "./base.css"
import "./lifecycle.mts"

if (import.meta.env.PROD && "serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js")
