// The service worker's entry, built to /sw.js (vite.config.mts), which pages register (src/shell/index.mts)

import { type Scope, start } from "./worker.mts"

start(self as unknown as Scope)
