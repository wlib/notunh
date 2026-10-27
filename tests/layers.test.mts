// Which way the source's dependencies run, read from every import, so a shortcut across layers fails here rather
// than tangling quietly. Geometry and the transit, places, routing and reminders domains import only what's beneath
// them and never the browser. Observations as stored never depend on what's made of them. The Worker and the scripts
// that train and replay reach none of the pages

import { test, expect } from "vitest"
import { globSync, readFileSync } from "node:fs"
import { dirname, join, normalize } from "node:path"

const ROOT = new URL("..", import.meta.url).pathname

/**
 * Each domain layer, by its folder, and the layers it may import besides its own. The timetable (src/transit/
 * itself) and what's observed sit side by side, what's inferred sits over both, the models over that, and routing
 * over all of it
 */
const LAYERS: Record<string, string[]> = {
  "src/shared":               [],
  "src/geo":                  ["src/shared"],
  "src/places":               ["src/shared", "src/geo"],
  "src/transit/observations": ["src/shared"],
  "src/transit":              ["src/shared", "src/geo"],
  "src/transit/inference":    ["src/shared", "src/geo", "src/transit", "src/transit/observations"],
  "src/transit/models":       ["src/shared", "src/geo", "src/transit", "src/transit/observations", "src/transit/inference"],
  "src/routing":              ["src/shared", "src/geo", "src/places", "src/transit", "src/transit/observations", "src/transit/inference", "src/transit/models"],
  "src/reminders":            ["src/shared", "src/geo", "src/transit", "src/transit/observations", "src/transit/inference", "src/transit/models", "src/routing"],
  "src/reminders/browser":    ["src/shared", "src/reminders"],
  "src/programs":             ["src/shared"],
  "src/courses":              ["src/shared", "src/social"],
  "src/parking":              ["src/shared", "src/geo", "src/routing"]
}

/**
 * The globals only a browser or its storage has. The reminders' domain (src/reminders/ itself) decides what a reminder
 * and a watch are and what a push means with none of them, and src/reminders/browser/ keeps and sends them
 */
const PLATFORM = /(?<![\w.$])(navigator|window|document|caches|indexedDB|localStorage|fetch)\b/

/**
 * What only a page has: bruh's reactivity and browser rendering (not its server rendering, which the build uses), the
 * map's renderer, and the pages' state, rendering, and UI
 */
const BROWSER = [/^bruh(\/(browser|reactive|components|utils\/browser)(\/|$)|$)/, /^maplibre-gl(\/|$)/, /^src\/map\/(state|render|ui)\//, /^src\/[^/]+\/(state\.mts|ui\/|index\.tsx)/]

type Import = { target: string, isType: boolean }

const IMPORT = /^(import|export)\s+(type\s+)?(?:[^"]*?\s+from\s+)?"([^"]+)"|import\("([^"]+)"\)/gm

/** A file's imports, each a repository path for our own files, else the package, and whether it's only for types */
const importsOf = (file: string): Import[] =>
  [...readFileSync(join(ROOT, file), "utf8").matchAll(IMPORT)].map(([, , isType, from, dynamic]) => {
    const specifier = (from ?? dynamic).split("?")[0]
    return {
      target: specifier.startsWith(".") ? normalize(join(dirname(file), specifier)) : specifier,
      isType: isType !== undefined
    }
  })

const files = globSync(["src/**/*.{mts,tsx}", "scripts/**/*.mts", "worker/**/*.mts"], { cwd: ROOT }).sort()
const imports = new Map(files.map(file => [file, importsOf(file)]))

/** Every file a file reaches at run time, itself included, and every package */
const reached = (file: string) => {
  const seen = new Set([file])
  for (const next of seen)
    for (const { target, isType } of imports.get(next) ?? [])
      if (!isType)
        seen.add(target)
  return seen
}

const layerOf = (file: string) =>
  dirname(file) in LAYERS ? dirname(file) : undefined

test("each domain layer imports only its own and the layers beneath it, and never a package only pages have", () => {
  const crossings = files.flatMap(file => {
    const layer = layerOf(file)
    if (!layer)
      return []
    return imports.get(file)!
      .filter(({ target }) =>
        target.startsWith("src/")
          ? ![layer, ...LAYERS[layer]].includes(dirname(target))
          : BROWSER.some(pattern => pattern.test(target))
      )
      .map(({ target }) => `${file} -> ${target}`)
  })
  expect(crossings).toEqual([])
})

test("every domain layer has files, so a folder renamed doesn't leave its rule checking nothing", () => {
  for (const layer of Object.keys(LAYERS))
    expect(files.some(file => layerOf(file) === layer), layer).toBe(true)
})

test("the Worker and the scripts, training and replay among them, never reach what only pages have", () => {
  const reaches = files
    .filter(file => /^(worker|scripts)\//.test(file))
    .flatMap(file => [...reached(file)].filter(target => BROWSER.some(pattern => pattern.test(target))).map(target => `${file} -> ${target}`))
  expect(reaches).toEqual([])
})

test("the reminders' domain touches no browser or storage global, which only its browser folder and the pages do", () => {
  const touches = files
    .filter(file => dirname(file) === "src/reminders")
    .flatMap(file => readFileSync(join(ROOT, file), "utf8").split("\n").flatMap((line, i) => {
      // Comments only mention them
      const code = /^\s*(\/\/|\/?\*)/.test(line) ? "" : line.replace(/\s\/\/\s.*$/, "")
      return PLATFORM.test(code) ? [`${file}:${i + 1}`] : []
    }))
  expect(touches).toEqual([])
})
