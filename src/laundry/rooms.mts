// UNH's laundry rooms, as scripts/laundry/rooms.mts lists them at build time, and the slug each is at under
// /laundry/, which the Worker's page route and the map's places go by too

import rooms from "./rooms.json"
import type { Room } from "./upstream.mts"
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
