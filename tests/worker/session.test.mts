/// <reference types="node" />
// The device's credential as the Worker's cookie (worker/session.mts): read back as set, among any other cookies, in
// any order; nothing that isn't one well formed reads as one; and it's HttpOnly, SameSite=Lax, for /api/ alone,
// kept 400 days, and Secure over https

import { test, expect } from "vitest"
import fc from "fast-check"
import { COOKIE, MAX_AGE, cookieOf, credentialFrom, forgetCookie } from "../../worker/session.mts"

const part = fc.stringMatching(/^[\w-]{16,64}$/)
const credential = fc.record({ device: part, secret: part })
const other = fc.tuple(fc.stringMatching(/^[a-z][\w-]{0,12}$/), fc.stringMatching(/^[\w.=-]{0,20}$/))
  .filter(([name]) => name !== COOKIE)
  .map(([name, value]) => `${name}=${value}`)

/** What a browser sends of a Set-Cookie: its name and value */
const sent = (setCookie: string) =>
  setCookie.split(";")[0]

test("a device's credential is read back from the cookie set, wherever it is among others", () =>
  fc.assert(fc.property(credential, fc.boolean(), fc.array(other, { maxLength: 4 }), fc.nat(), (kept, isSecure, others, at) => {
    const cookies = [...others]
    cookies.splice(at % (others.length + 1), 0, sent(cookieOf(kept, isSecure)))
    expect(credentialFrom(cookies.join("; "))).toEqual(kept)
  }))
)

test("the cookie is HttpOnly, Lax, for the API alone, kept 400 days, Secure only over https, and forgotten at once", () =>
  fc.assert(fc.property(credential, fc.boolean(), (kept, isSecure) => {
    const attributes = cookieOf(kept, isSecure).split("; ").slice(1)
    expect(attributes).toEqual(expect.arrayContaining([`Max-Age=${MAX_AGE}`, "Path=/api/", "HttpOnly", "SameSite=Lax"]))
    expect(attributes.includes("Secure")).toBe(isSecure)
    expect(MAX_AGE).toBe(400 * 86400)
    expect(credentialFrom(sent(forgetCookie(isSecure)))).toBeUndefined()
  }))
)

test("nothing but a well formed credential under the cookie's name reads as one", () =>
  fc.assert(fc.property(fc.oneof(credential.map(({ device, secret }) => `${device}.${secret}`), fc.string({ maxLength: 120 }).filter(value => !value.includes(";") && value.trim() === value)), fc.array(other, { maxLength: 3 }), (value, others) => {
    const found = credentialFrom([...others, `${COOKIE}=${value}`].join("; "))
    const isWellFormed = /^[\w-]{16,200}\.[\w-]{16,200}$/.test(value)
    expect(found !== undefined).toBe(isWellFormed)
    if (found)
      expect(`${found.device}.${found.secret}`).toBe(value)
  }))
)

test("no cookie, or none of ours, is no credential", () => {
  expect(credentialFrom(undefined)).toBeUndefined()
  expect(credentialFrom("")).toBeUndefined()
  expect(credentialFrom("theme=dark; usage=yes")).toBeUndefined()
})
