// The service worker's entry, built to /sw.js (vite.config.mts), which pages register (src/shell/index.mts)

import { type Scope, start } from "./worker.mts"
import { type PushScope, startPush } from "./push.mts"
import { keep, reminderOf } from "../reminders/browser/store.mts"
import { moveOn } from "../reminders/browser/sync.mts"

const { registration } = self as unknown as { registration: ServiceWorkerRegistration }

start(self as unknown as Scope)
startPush(self as unknown as PushScope, { reminderOf, keep }, undefined, async (id, wake) =>
  moveOn(id, Date.now() / 1000, (await registration.pushManager.getSubscription())?.toJSON(), wake)
)
