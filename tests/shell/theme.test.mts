import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { ColorSpace, parse, serialize, sRGB, to, OKLCH } from "colorjs.io/fn"
import { SURFACE } from "../../src/shell/theme.mts"

ColorSpace.register(sRGB)
ColorSpace.register(OKLCH)

const css = readFileSync(new URL("../../src/shell/base.css", import.meta.url), "utf8")
const manifest = JSON.parse(readFileSync(new URL("../../public/manifest.webmanifest", import.meta.url), "utf8"))

const hex = (color: string) => serialize(to(parse(color), "srgb"), { format: "hex" })

test("the browser's bars and the manifest match the page background, light and dark", () => {
  const [light, dark] = [...css.matchAll(/--surface:\s*([^;]+);/g)].map(([, value]) => hex(value))
  expect(SURFACE).toEqual({ light, dark })
  expect(manifest.background_color).toBe(light)
  expect(manifest.theme_color).toBe(light)
})
