// Fetching JSON, which the pages, the Worker, and the build all do the same way

/** What a URL answers with as JSON, or an error saying what it answered instead */
export const getJson = async <T,>(url: string | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init)
  if (!response.ok)
    throw new Error(`${response.status} from ${url}`)
  return response.json()
}
