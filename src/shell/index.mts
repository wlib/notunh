// What every page of the app starts with: the shared styles, and offline support once built

import "./base.css"

if (import.meta.env.PROD && "serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js")
