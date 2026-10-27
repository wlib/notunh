/// <reference types="node" />
// The Worker's app served over HTTP for the browser tests (tests/browser/social.browser.mts), on a fresh in-memory
// database (d1.mts), with the built site in a folder as its assets and a mailer that keeps the last message, which
// GET /__mail answers, so a test can read a code the way a person reads their inbox. Prints the port it listens on.
// Run as `node tests/worker/serve.mts <dist>`

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { registerHooks } from "node:module"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import type { Env } from "../../worker/env.mts"
import type { Message } from "../../worker/mail.mts"
import { d1 } from "./d1.mts"
import { load, resolve } from "./hooks.mts"

// The Worker imports JSON, WebAssembly and fonts as wrangler bundles them, so Node is taught to before it's loaded
registerHooks({ resolve, load })
const { app } = await import("../../worker/api.mts")

const dist = process.argv[2]
let last: Message | undefined

const env = {
  DB: d1(),
  ASSETS: {
    fetch: async (input: RequestInfo | URL) => {
      const { pathname } = new URL(input instanceof Request ? input.url : input)
      return readFile(join(dist, pathname.endsWith("/") ? `${pathname}index.html` : pathname))
        .then(body => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } }), () => new Response("", { status: 404 }))
    }
  },
  EMAIL: { send: async ({ to, subject, text }: Message) => (last = { to, subject, text }, { messageId: "test" }) }
} as unknown as Env

const server = createServer(async (request, response) => {
  const url = new URL(request.url!, "http://notunh.app")
  if (url.pathname === "/__mail")
    return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(last ?? null))
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(chunk as Buffer)
  const answer = await app.fetch(new Request(url, {
    method: request.method,
    headers: Object.fromEntries(Object.entries(request.headers).filter(([, value]) => typeof value === "string") as [string, string][]),
    body: chunks.length ? Buffer.concat(chunks) : undefined
  }), env)
  response.writeHead(answer.status, Object.fromEntries(answer.headers))
  response.end(Buffer.from(await answer.arrayBuffer()))
})

server.listen(0, "127.0.0.1", () => {
  console.log(`PORT ${(server.address() as AddressInfo).port}`)
})
