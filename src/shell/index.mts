// What every page of the app starts with: the shared styles, the lifecycle (a fresh start after a long while away),
// the question of usage stats, keeping your things with the Worker, and the service worker in production builds

import "./base.css"
import "./lifecycle.mts"
import "./usage.tsx"
import { startSync } from "./sync.mts"

startSync()

if (import.meta.env.PROD && "serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js")
