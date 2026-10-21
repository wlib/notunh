// A browser's storage for the reminders' tests: Cache Storage and Web Locks in memory, which every tab and the service
// worker of a test share, as the phone's do, and which can be made to fail, as in private browsing or when full

import { getOrCreate } from "../../src/shared/group.mts"

export const browserStorage = () => {
  const caches = new Map<string, Map<string, { body: string, type: string }>>()
  let isFailing = false
  const cacheOf = (entries: Map<string, { body: string, type: string }>) => ({
    match: async (key: string) => {
      if (isFailing)
        throw new DOMException("The cache can't be read", "InvalidStateError")
      const hit = entries.get(key)
      return hit && new Response(hit.body, { headers: { "content-type": hit.type } })
    },
    put: async (key: string, response: Response) => {
      const body = await response.text()
      if (isFailing)
        throw new DOMException("The quota has been exceeded", "QuotaExceededError")
      entries.set(key, { body, type: response.headers.get("content-type") ?? "" })
    }
  })
  // Each lock's holders, one after another in the order they asked
  const queues = new Map<string, Promise<unknown>>()
  const locks = {
    request: <T,>(name: string, run: () => Promise<T>) => {
      const next = (queues.get(name) ?? Promise.resolve()).then(run)
      queues.set(name, next.catch(() => {}))
      return next
    }
  }
  return {
    caches:     { open: async (name: string) => cacheOf(getOrCreate(caches, name, () => new Map())) },
    locks,
    setFailing: (failing: boolean) => isFailing = failing,
    /** What a cache holds, parsed, by key */
    entriesOf:  (name: string) => new Map([...caches.get(name) ?? []].map(([key, { body }]) => [key, JSON.parse(body) as unknown]))
  }
}
