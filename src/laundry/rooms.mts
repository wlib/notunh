// UNH's laundry rooms, as scripts/laundry/rooms.mts lists them at build time, the slug each is at under /laundry/,
// which the Worker's page route and the map's places go by too, and what a room's own page says of itself

import rooms from "./rooms.json" with { type: "json" }
import type { Room } from "./upstream.mts"
import type { Summary } from "../shell/served.tsx"
import { slug } from "../shared/slug.mts"

export const ROOMS: readonly Room[] = rooms

export const roomName = (id: string) =>
  ROOMS.find(room => room.id === id)?.name ?? id

/** The room at a slug of its name, or undefined for any other */
export const roomAtSlug = (name: string) =>
  ROOMS.find(room => slug(room.name) === name)

/** A room's path, or the list's for none */
export const pathOf = (id: string | undefined) =>
  id === undefined ? "/laundry/" : `/laundry/${slug(roomName(id))}/`

/** The room a path opens, or undefined for the list or any other path */
export const roomAtPath = (pathname: string) => {
  const slug = pathname.match(/^\/laundry\/([^/]+)\/?$/)?.[1]
  return slug === undefined ? undefined : roomAtSlug(slug)?.id
}

/** A room's own page, as the Worker heads and summarizes it (worker/preview.mts): the room, and the way there */
export const roomSummary = (room: Room): Summary => ({
  preview: { kind: "Laundry room", title: `${room.name} laundry`, lines: [`Which washers and dryers are free in ${room.name} at UNH now, and how long the rest have left`] },
  parts:   [{ heading: "Getting there", items: [{ text: `Directions to ${room.name}`, href: `/map/?to=laundry/${slug(room.name)}` }] }]
})
