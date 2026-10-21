// The Worker's reminder routes (worker/api.mts, docs/reminders.md), each asked as the device by its secret. An
// answer is done, refused for something of ours, which asking again won't mend, or unreachable, as offline, with the
// Worker down, or asked too often from this address, which is asked again when the map next loads or the phone comes
// back online

import * as v from "valibot"
import { getJson } from "../../shared/json.mts"
import { fromBase64Url } from "../../shared/base64url.mts"
import type { Watch } from "../watch.mts"
import type { Device } from "./store.mts"

export type Answer = { kind: "done" } | { kind: "unreachable" } | { kind: "refused", why: string }

/** What a watch is set with: the push subscription, as the browser gives it, and the watch */
export type Setting = { subscription: PushSubscriptionJSON, watch: Watch }

const DONE: Answer = { kind: "done" }
const UNREACHABLE: Answer = { kind: "unreachable" }

/** The Worker's VAPID public key, which pushes are subscribed to with */
export const key = async () =>
  fromBase64Url((await getJson("/api/push/key", { schema: v.object({ key: v.string() }) })).key)

/** The Worker's answer to the device, by status: 5xx, and 429 for too many asked from the address, as unreachable, since it's worth asking again; the rest, like 409 for too many reminders at once, as refused */
const ask = async (method: "PUT" | "DELETE", path: string, { secret }: Device, body?: unknown) => {
  try {
    const response = await fetch(path, {
      method,
      headers: { authorization: `Bearer ${secret}`, ...body === undefined ? {} : { "content-type": "application/json" } },
      body:    body === undefined ? undefined : JSON.stringify(body)
    })
    if (response.ok)
      return DONE
    return response.status >= 500 || response.status === 429 ? UNREACHABLE : { kind: "refused" as const, why: `${response.status} ${await response.text()}` }
  }
  catch {
    return UNREACHABLE
  }
}

/** Sets a reminder's watch, which replaces any the Worker has of the id */
export const set = (device: Device, id: string, setting: Setting) =>
  ask("PUT", `/api/reminders/${encodeURIComponent(id)}`, device, { device: device.id, ...setting })

/** Cancels a reminder: done too when the Worker doesn't know the device or the reminder, as there's nothing to cancel then */
export const cancel = async (device: Device, id: string): Promise<Answer> => {
  const answer = await ask("DELETE", `/api/reminders/${encodeURIComponent(id)}?device=${encodeURIComponent(device.id)}`, device)
  return answer.kind === "refused" ? DONE : answer
}

/** Has the Worker forget the device and its reminders, done likewise when it already has */
export const forget = async (device: Device): Promise<Answer> => {
  const answer = await ask("DELETE", `/api/push/devices/${encodeURIComponent(device.id)}`, device)
  return answer.kind === "refused" ? DONE : answer
}
