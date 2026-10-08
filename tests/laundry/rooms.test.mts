import { test, expect } from "vitest"
import fc from "fast-check"
import { ROOMS, pathOf, roomAtPath } from "../../src/laundry/rooms.mts"
import { slug } from "../../src/shared/slug.mts"

test("every room has a slug of its own, made of letters, digits, and dashes, that its path leads back to", () => {
  const slugs = ROOMS.map(({ name }) => slug(name))
  expect(new Set(slugs).size).toBe(ROOMS.length)
  for (const [i, slug] of slugs.entries()) {
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(pathOf(ROOMS[i].id)).toBe(`/laundry/${slug}/`)
    expect(roomAtPath(pathOf(ROOMS[i].id))).toBe(ROOMS[i].id)
    expect(roomAtPath(`/laundry/${slug}`)).toBe(ROOMS[i].id)
  }
  expect(slug("Stoke Hall G05")).toBe("stoke-hall-g05")
  expect(roomAtPath("/laundry/")).toBeUndefined()
  expect(pathOf(undefined)).toBe("/laundry/")
})

test("any other path opens the list rather than a room", () =>
  fc.assert(fc.property(fc.string(), path => {
    const room = roomAtPath(path)
    if (room !== undefined)
      expect(path.replace(/\/$/, "")).toBe(pathOf(room).replace(/\/$/, ""))
  }))
)
