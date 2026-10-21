import { test, expect } from "vitest"
import fc from "fast-check"
import { encrypt, fromBase64Url, localOf, push, toBase64Url, vapidAuthorization, type Subscription } from "../../worker/push.mts"
import { browser, vapidKeys } from "./webpush.mts"

// RFC 8291's example (section 5 and Appendix A), with the whitespace the RFC wraps its base64url in taken out
const RFC = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic:  "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt:      "DGv6ra1nlYgDCS1FRnbzlw",
  auth:      "BTBZMqHH6r4Tts7J_aSIgg",
  header:    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  record:    "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ"
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

test("encrypting RFC 8291's example with its keys and salt gives the RFC's header and record", async () => {
  const local = await localOf(fromBase64Url(RFC.asPublic), fromBase64Url(RFC.asPrivate))
  const body = await encrypt(fromBase64Url(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, { local, salt: fromBase64Url(RFC.salt) })
  expect(toBase64Url(body.slice(0, 86))).toBe(RFC.header)
  expect(toBase64Url(body.slice(86))).toBe(RFC.record)
})

test("whatever is encrypted for a browser, the browser reads back, no two encryptions look alike, and base64url round-trips any bytes", async () => {
  const { keys, decrypt } = await browser()
  await fc.assert(fc.asyncProperty(fc.string({ maxLength: 2000 }), fc.uint8Array({ maxLength: 100 }), async (message, bytes) => {
    const [a, b] = [await encrypt(encoder.encode(message), keys), await encrypt(encoder.encode(message), keys)]
    expect(await decrypt(a)).toBe(message)
    expect(toBase64Url(a)).not.toBe(toBase64Url(b))
    expect(toBase64Url(bytes)).toMatch(/^[\w-]*$/)
    expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes])
  }), { numRuns: 30 })
})

test("the VAPID token is for the endpoint's origin, from our subject, good for less than a day, and verifies with our public key", async () => {
  const vapid = await vapidKeys()
  const now = 1_790_000_000
  const header = await vapidAuthorization("https://web.push.apple.com/QGuQyavXutnMH", vapid, now)
  const [, token, key] = header.match(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/)!
  expect(key).toBe(vapid.publicKey)
  const [head, claims, signature] = token.split(".")
  expect(JSON.parse(decoder.decode(fromBase64Url(head)))).toEqual({ typ: "JWT", alg: "ES256" })
  const { aud, exp, sub } = JSON.parse(decoder.decode(fromBase64Url(claims)))
  expect(aud).toBe("https://web.push.apple.com")
  expect(sub).toBe("https://notunh.app")
  expect(exp - now).toBeGreaterThan(3600)
  expect(exp - now).toBeLessThanOrEqual(86400)
  const verifier = await crypto.subtle.importKey("raw", fromBase64Url(vapid.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, fromBase64Url(signature), encoder.encode(`${head}.${claims}`))).toBe(true)
})

test("a push is one POST to the endpoint with RFC 8030's headers, the browser reads it, and the service's answer says what became of the subscription", async () => {
  const vapid = await vapidKeys()
  const { keys, decrypt } = await browser()
  const subscription: Subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys }
  let request!: Request
  const sent = (status: number) => push(subscription, "{\"hello\":1}", vapid, { ttl: 120.4, topic: "r1" }, 1_790_000_000, async sent => (request = sent as Request, new Response(null, { status })))
  expect(await sent(201)).toEqual({ sent: "sent" })
  expect(request.method).toBe("POST")
  expect(request.url).toBe(subscription.endpoint)
  expect(Object.fromEntries([...request.headers].filter(([name]) => name !== "authorization"))).toEqual({
    "content-encoding": "aes128gcm",
    "content-type":     "application/octet-stream",
    ttl:                "120",
    urgency:            "high",
    topic:              "r1"
  })
  expect(request.headers.get("authorization")).toMatch(/^vapid t=/)
  expect(await decrypt(new Uint8Array(await request.arrayBuffer()))).toBe("{\"hello\":1}")
  for (const [status, result] of [[404, "gone"], [410, "gone"], [429, "retry"], [503, "retry"], [400, "refused"], [403, "refused"], [413, "refused"]] as const)
    expect((await sent(status)).sent).toBe(result)
  expect(await push(subscription, "x", vapid, { ttl: 60, topic: "r1" }, 0, async () => { throw new TypeError("offline") })).toEqual({ sent: "retry" })
  // A service that says when to come back is heeded
  expect(await push(subscription, "x", vapid, { ttl: 60, topic: "r1" }, 0, async () => new Response(null, { status: 429, headers: { "retry-after": "90" } }))).toEqual({ sent: "retry", after: 90 })
})
