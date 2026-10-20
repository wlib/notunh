// What every page of the app starts with: the shared styles, the lifecycle (a fresh start after a long while away),
// and the service worker in production builds

import "./base.css"
import "./lifecycle.mts"

if (import.meta.env.PROD && "serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js")
