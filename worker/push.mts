// Web Push from the Worker with WebCrypto alone: the message encrypted for one browser (RFC 8291, the aes128gcm
// content coding of RFC 8188), and the request signed as ours with VAPID (RFC 8292), as RFC 8030 sends it.
// tests/worker/push.test.mts checks the encryption against RFC 8291's own example

import * as v from "valibot"
import { fromBase64Url, toBase64Url } from "../src/shared/base64url.mts"

/** The push services browsers subscribe with: Apple's, Google's, Mozilla's, and Microsoft's, so nothing else is posted to */
const PUSH_HOSTS = /^(?:[\w-]+\.)*(?:push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/

const Base64Url = v.pipe(v.string(), v.regex(/^[\w-]+$/))

/** A browser's push subscription, as PushSubscription.toJSON() gives it, at a push service's address */
export const Subscription = v.object({
  endpoint: v.pipe(v.string(), v.maxLength(2000), v.url(), v.check(url => {
    const { protocol, hostname } = new URL(url)
    return protocol === "https:" && PUSH_HOSTS.test(hostname)
  }, "A push service's address")),
  keys: v.object({ p256dh: v.pipe(Base64Url, v.maxLength(200)), auth: v.pipe(Base64Url, v.maxLength(200)) })
})
export type Subscription = v.InferOutput<typeof Subscription>

/** The Worker's VAPID key pair, each base64url: the public key's 65 raw bytes, and the private key's 32 */
export type Vapid = { publicKey: string, privateKey: string, subject: string }

/**
 * How a push service answered: taken, gone for good, worth trying again later, after the seconds it asked for if it
 * did (RFC 8030 8.4), or refused for something of ours, which trying again won't mend
 */
export type Sent = { sent: "sent" | "gone" | "refused" } | { sent: "retry", after?: number }

// A record holds the whole message, which push services cap at 4 KB
const RECORD_SIZE = 4096
// Apple refuses a VAPID token good for more than a day
const TOKEN_SECONDS = 12 * 3600

const encoder = new TextEncoder()

const concat = (...parts: Uint8Array[]) => {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  parts.reduce((offset, part) => (bytes.set(part, offset), offset + part.length), 0)
  return bytes
}

/** A P-256 key as a JWK, from its raw public point and, for a private key, its scalar */
const jwkOf = (publicKey: Uint8Array, d?: Uint8Array): JsonWebKey =>
  ({ kty: "EC", crv: "P-256", x: toBase64Url(publicKey.slice(1, 33)), y: toBase64Url(publicKey.slice(33, 65)), ...d ? { d: toBase64Url(d) } : {} })

const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) =>
  new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
    bytes * 8
  ))

/** The server's ECDH key pair for one message: fresh, or as RFC 8291's example gives its own */
export type Local = { publicKey: Uint8Array, privateKey: CryptoKey }

export const localOf = async (publicKey: Uint8Array, d: Uint8Array): Promise<Local> =>
  ({ publicKey, privateKey: await crypto.subtle.importKey("jwk", jwkOf(publicKey, d), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) })

const ephemeral = async (): Promise<Local> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair
  return { publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer), privateKey: pair.privateKey }
}

/** A message encrypted for a subscription (RFC 8291): the 86-byte header (salt, record size, the server's public key), then one record */
export const encrypt = async (message: Uint8Array, keys: Subscription["keys"], { local, salt }: { local?: Local, salt?: Uint8Array } = {}) => {
  local ??= await ephemeral()
  salt ??= crypto.getRandomValues(new Uint8Array(16))
  const uaPublic = fromBase64Url(keys.p256dh)
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, [])
  // Cloudflare's types name the peer's key $public, as the runtime spells reserved words in its types, but it reads public
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256))
  const ikm = await hkdf(fromBase64Url(keys.auth), secret, concat(encoder.encode("WebPush: info\0"), uaPublic, local.publicKey), 32)
  const key = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16), "AES-GCM", false, ["encrypt"])
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12)
  // The last record's delimiter is 2, and it's the only record
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(message, Uint8Array.of(2))))
  const header = new Uint8Array(21)
  header.set(salt)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = local.publicKey.length
  return concat(header, local.publicKey, record)
}

/** The VAPID signing key, imported once per Worker */
let signing: { publicKey: string, key: Promise<CryptoKey> } | undefined
const signingKey = ({ publicKey, privateKey }: Vapid) => {
  if (signing?.publicKey !== publicKey)
    signing = { publicKey, key: crypto.subtle.importKey("jwk", jwkOf(fromBase64Url(publicKey), fromBase64Url(privateKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) }
  return signing.key
}

/** The Authorization header for a push service (RFC 8292): a JWT for the endpoint's origin, signed ES256, which WebCrypto gives as the raw r and s that JWS wants */
export const vapidAuthorization = async (endpoint: string, vapid: Vapid, now: number) => {
  const part = (value: object) => toBase64Url(encoder.encode(JSON.stringify(value)))
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now) + TOKEN_SECONDS, sub: vapid.subject })}`
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await signingKey(vapid), encoder.encode(unsigned)))
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${vapid.publicKey}`
}

export type PushOptions = {
  /** Seconds the push service may hold it while the device is unreachable */
  ttl:   number,
  /** Replaces a message with the same topic the service still holds, up to 32 base64url characters */
  topic: string
}

/**
 * Pushes a message with RFC 8030's headers, high urgency as these are about a bus, with fetch given for tests. 404
 * and 410 say the subscription's gone for good (RFC 8030 7.3), 429 and 5xx are worth another try, and anything else,
 * like a refused token, is ours to mend
 */
export const push = async (subscription: Subscription, message: string, vapid: Vapid, { ttl, topic }: PushOptions, now: number, send = fetch): Promise<Sent> => {
  try {
    const { status, headers } = await send(new Request(subscription.endpoint, {
      method:  "POST",
      headers: {
        authorization:      await vapidAuthorization(subscription.endpoint, vapid, now),
        "content-encoding": "aes128gcm",
        "content-type":     "application/octet-stream",
        ttl:                String(Math.max(1, Math.round(ttl))),
        urgency:            "high",
        topic
      },
      body: await encrypt(encoder.encode(message), subscription.keys)
    }))
    if (status < 200 || status >= 300)
      console.warn(`A push service answered ${status}`)
    if (status >= 200 && status < 300)
      return { sent: "sent" }
    if (status === 404 || status === 410)
      return { sent: "gone" }
    if (status === 429 || status >= 500) {
      const after = Number(headers.get("retry-after"))
      return { sent: "retry", ...after > 0 && { after } }
    }
    return { sent: "refused" }
  }
  catch (error) {
    console.warn("A push service couldn't be reached", error)
    return { sent: "retry" }
  }
}
