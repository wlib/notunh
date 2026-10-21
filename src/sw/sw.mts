// The service worker's entry, built to /sw.js (vite.config.mts), which pages register (src/shell/index.mts)

import { type Scope, start } from "./worker.mts"
import { type PushScope, startPush } from "./push.mts"
import { reminderOf } from "../reminders/store.mts"

start(self as unknown as Scope)
startPush(self as unknown as PushScope, { reminderOf })
