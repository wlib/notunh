// What a page's <head> says of its build, which is the release manifest both the page and the service worker go
// by: the release it came from, the code it runs, and the data it loads, each by name. Pages and worker share this,
// so nothing else of either needs to agree on how a head is read

import * as v from "valibot"

export type Build = {
  /** When the page was built, as the head's release meta says, which orders releases; empty for a page without one */
  release: string,
  /** Everything else of ours the head names, in order: scripts, stylesheets, workers, icons, and the manifest, which a page can only take in by reloading */
  code:    string[],
  /** Each data file's URL, by its name */
  data:    Record<string, string>
}

/** What a data file asks the cache to keep for it, beyond itself: files by path, and whole folders by prefix */
export const Retain = v.object({ files: v.optional(v.array(v.string())), folders: v.optional(v.array(v.string())) })
export type Retain = v.InferOutput<typeof Retain>

/** A build and all it keeps, which is what one page in one release needs to work */
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
    }
    else if (dataName && href)
      build.data[dataName] = href
    else if ((src ?? href)?.startsWith("/"))
      build.code.push(src ?? href)
  }
  return build
}

export const isSameCode = (a: Build, b: Build) =>
  a.code.join(" ") === b.code.join(" ")

export const isSameBuild = (a: Build, b: Build) =>
  isSameCode(a, b) && JSON.stringify(Object.entries(a.data).sort()) === JSON.stringify(Object.entries(b.data).sort())

/** Everything a build names: its code and its data files */
export const closureOf = ({ code, data }: Build) =>
  [...code, ...Object.values(data)]

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

/** What a data file asks to be kept, going by its shape, which is nothing for most */
export const retainOf = (value: unknown): Required<Retain> => {
  const { files, folders } = Object(value) as Retain
  return { files: strings(files), folders: strings(folders) }
}

export const mergedRetain = (retains: Required<Retain>[]): Required<Retain> =>
  ({ files: retains.flatMap(retain => retain.files), folders: retains.flatMap(retain => retain.folders) })

/** Whether a path is some generation's: in its build's closure, or kept by its data */
export const isRetained = (generations: Generation[]) => {
  const files = new Set(generations.flatMap(({ build, retain }) => [...closureOf(build), ...retain.files]))
  const folders = new Set(generations.flatMap(({ retain }) => retain.folders))
  return (pathname: string) =>
    files.has(pathname) || [...folders].some(folder => pathname.startsWith(folder))
}
