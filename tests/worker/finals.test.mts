/// <reference types="node" />
// Final exams through the Worker (worker/finals.mts): stored by the nightly run with the build's token beside the
// models, told by term only to a device whose person holds a verified UNH address, refused to anyone else, and in a
// person's calendar feed only once they hold one

import { test, expect, vi } from "vitest"
import { readFile } from "node:fs/promises"
import { URL } from "node:url"
import { app } from "../../worker/api.mts"
import type { Env } from "../../worker/env.mts"
import type { Message } from "../../worker/mail.mts"
import type { CoursesIndex } from "../../src/courses/course.mts"
import { type Finals, type Told, FINALS } from "../../src/courses/finals.mts"
import { calendarPath } from "../../src/social/calendar.mts"
import { addDays } from "../../src/shared/time.mts"
import { fallFinals } from "../courses/fixtures.mts"
import { d1 } from "./d1.mts"

const DATA = new URL("../fixtures/data/", import.meta.url)
const index = JSON.parse(await readFile(new URL("src/courses/courses.json", DATA), "utf8")) as CoursesIndex
const live = index.terms[0]

// The Worker's clock, pinned within the fixtures' term
vi.useFakeTimers({ toFake: ["Date"] })
vi.setSystemTime(Date.parse(`${addDays(live.from, 30)}T16:00:00Z`))

const PAGE = `<html><head><meta name="release" content="2026-10-07T00:00:00Z"><link rel="data" href="/src/courses/courses.json" data-name="courses"><link rel="data" href="/src/map/events.json" data-name="events"></head></html>`
const TOKEN = "build-token-for-tests"

const finals: Finals = { version: 1, through: "2026-11-18", terms: { [live.code]: { name: live.name, source: "https://example.org/sheet", fetched: 1, finals: fallFinals } } }

const worker = () => {
  const sent: Message[] = []
  const env = {
    DB:          d1(),
    BUILD_TOKEN: TOKEN,
    ASSETS:      {
      fetch: async (input: RequestInfo | URL) => {
        const { pathname } = new URL(input instanceof Request ? input.url : input)
        return pathname === "/map/"
          ? new Response(PAGE, { headers: { "content-type": "text/html" } })
          : readFile(new URL(pathname.startsWith("/data/") ? `public${pathname}` : pathname.slice(1), DATA)).then(body => new Response(body), () => new Response("", { status: 404 }))
      }
    },
    EMAIL: { send: async ({ to, subject, text }: Message) => (sent.push({ to, subject, text }), { messageId: `test-${sent.length}` }) }
  } as unknown as Env
  const request = (path: string, { body, bearer }: { body?: unknown, bearer?: string } = {}) =>
    app.fetch(new Request(`http://notunh.app${path}`, {
      method:  body ? "POST" : "GET",
      headers: { ...body ? { "content-type": "application/json" } : {}, ...bearer && { authorization: `Bearer ${bearer}` } },
      ...body ? { body: JSON.stringify(body) } : {}
    }), env)
  const device = (name: string) => {
    const id = name.padEnd(16, "_")
    const secret = `secret-of-${id}`
    const command = (path: string, body: object) => request(path, { body: { device: id, ...body }, bearer: secret })
    return {
      id,
      command,
      read:   (path: string) => request(`${path}?device=${id}`, { bearer: secret }),
      verify: async (address: string) => {
        await command("/api/email", { address })
        await command("/api/email/verify", { address, code: sent.at(-1)!.subject.slice(0, 6) })
      }
    }
  }
  return { request, device }
}

test("finals are stored only with the build's token, and told by term only to a verified device, privately", async () => {
  const { request, device } = worker()
  expect((await request(`/api/models/${FINALS}`, { body: { expect: null, state: finals } })).status).toBe(401)
  expect((await request(`/api/models/${FINALS}`, { body: { expect: null, state: finals }, bearer: TOKEN })).status).toBe(204)

  // Anyone, and a device of no verified address, is refused, and told nothing of any section
  const ask = `/api/finals/${live.code}`
  for (const answer of [await request(ask), await device("plain").read(ask)]) {
    expect(answer.status).toBe(403)
    expect(answer.headers.get("cache-control")).toBe("private, no-store")
    expect(await answer.text()).not.toMatch(/\d{5}|Kingsbury/)
  }

  const verified = device("verified")
  await verified.command("/api/state", { entries: {} })
  await verified.verify("wildcat@unh.edu")
  const answer = await verified.read(ask)
  expect(answer.status).toBe(200)
  expect(answer.headers.get("cache-control")).toBe("private, no-store")
  expect(await answer.json()).toEqual({ code: live.code, fetched: 1, finals: fallFinals } satisfies Told)
  expect((await verified.read("/api/finals/202650")).status).toBe(404)
})

test("a person's feed has their saved sections' finals once they hold a verified address, and not before", async () => {
  const { request, device } = worker()
  await request(`/api/models/${FINALS}`, { body: { expect: null, state: finals }, bearer: TOKEN })
  const person = device("feed")
  const token = "t".repeat(22)
  await person.command("/api/state", { entries: {
    "courses-saved": { at: 1, by: "browser", value: [`${live.code}:12496`, `${live.code}:11267`] },
    "calendar-feed": { at: 1, by: "browser", value: token }
  } })
  const feed = async () => (await request(calendarPath("feed", token))).text()
  expect(await feed()).not.toContain("-final")
  await person.verify("wildcat@unh.edu")
  const told = (await feed()).replace(/\r\n /g, "")
  expect(told).toContain(`UID:course-${live.code}-12496-final@notunh.app`)
  expect(told).toContain(`UID:course-${live.code}-11267-final-2@notunh.app`)
  expect(told).toContain("LOCATION:Kingsbury N343")
})
