// What a page's <head> says of its build: the release manifest both the page and the service worker go by. It names
// the release, the code the page runs, and the data files it loads by name. Pages and worker share this module, so
// nothing else needs to agree on how a head is read

import * as v from "valibot"

export type Build = {
  /** When the page was built (ISO 8601), from the head's release meta; empty for a page without one */
  release:    string,
  /** When it was republished after it was built, as a rollback by scripts/republish.mts is, from the published meta */
  published?: string,
  /**
   * Everything else of ours the head names, in order: scripts, stylesheets, workers, icons, and the web manifest.
   * A page can only take these in by reloading
   */
  code:       string[],
  /** Each data file's URL, by its name */
  data:       Record<string, string>
}

/**
 * What a data file asks the cache to keep beyond itself:
 * - required: files it can't work without, staged with it before its page is kept, like the map style's style.json
 * - files: files kept if they're cached, like the dining index's, which load as they're opened
 * - folders: whole folders by path prefix, like the tiles' and the style's
 */
export const Retain = v.object({ required: v.optional(v.array(v.string())), files: v.optional(v.array(v.string())), folders: v.optional(v.array(v.string())) })
export type Retain = v.InferOutput<typeof Retain>

/** A build and everything it retains: what one page of one release needs to work */
export type Generation = { build: Build, retain: Required<Retain> }

const TAG = /<(?:meta|script|link)\b[^>]*>/g
const ATTRIBUTE = /([\w-]+)="([^"]*)"/g

const attributesOf = (tag: string) =>
  Object.fromEntries([...tag.matchAll(ATTRIBUTE)].map(([, key, value]) => [key, value]))

/** What a page's HTML, or its head's, says of its build */
export const buildOf = (html: string): Build => {
  const build: Build = { release: "", code: [], data: {} }
  for (const [tag] of html.split("</head>")[0].matchAll(TAG)) {
    const { name, content, src, href, "data-name": dataName } = attributesOf(tag)
    if (tag.startsWith("<meta")) {
      if (name === "release" && content)
        build.release = content
      else if (name === "published" && content)
        build.published = content
    }
    else if (dataName && href)
      build.data[dataName] = href
    else if ((src ?? href)?.startsWith("/"))
      build.code.push(src ?? href)
  }
  return build
}

/**
 * Whether a copy of a page was published before another, which is how copies are ordered. A copy from an edge not
 * yet caught up is older than the one it replaced. A republished build, as a rollback is, is newer than any built
 * before it was republished. So pages and the worker follow a rollback, and a stale edge can't undo it
 */
export const isOlder = (a: Build, b: Build) =>
  (a.published ?? a.release) < (b.published ?? b.release)

export const isSameCode = (a: Build, b: Build) =>
  a.code.join(" ") === b.code.join(" ")

export const isSameBuild = (a: Build, b: Build) =>
  isSameCode(a, b) && JSON.stringify(Object.entries(a.data).sort()) === JSON.stringify(Object.entries(b.data).sort())

/** Everything a build names: its code and its data files */
export const closureOf = ({ code, data }: Build) =>
  [...code, ...Object.values(data)]

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

/** What a data file asks the cache to retain, read from its top-level Retain fields; nothing for most files */
export const retainOf = (value: unknown): Required<Retain> => {
  const { required, files, folders } = Object(value) as Retain
  return { required: strings(required), files: strings(files), folders: strings(folders) }
}

export const mergedRetain = (retains: Required<Retain>[]): Required<Retain> =>
  ({ required: retains.flatMap(retain => retain.required), files: retains.flatMap(retain => retain.files), folders: retains.flatMap(retain => retain.folders) })

/** Whether a path belongs to some generation: in its build's closure, or retained by its data */
export const isRetained = (generations: Generation[]) => {
  const files = new Set(generations.flatMap(({ build, retain }) => [...closureOf(build), ...retain.required, ...retain.files]))
  const folders = new Set(generations.flatMap(({ retain }) => retain.folders))
  return (pathname: string) =>
    files.has(pathname) || [...folders].some(folder => pathname.startsWith(folder))
}
