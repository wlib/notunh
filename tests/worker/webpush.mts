// A browser's side of Web Push for tests: a subscription's keys and what it makes of a pushed message, as RFC 8291
// has the user agent do, and a VAPID key pair of the Worker's

import { expect } from "vitest"
import type { Vapid } from "../../worker/push.mts"
import { toBase64Url } from "../../src/shared/base64url.mts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: string | Uint8Array, bytes: number) =>
  new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: typeof info === "string" ? encoder.encode(info) : info },
    await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
    bytes * 8
  ))

/** A browser's side: its key pair and auth secret, and what it makes of a message, as RFC 8291 has the user agent do */
export const browser = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer)
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const keys = { p256dh: toBase64Url(publicKey), auth: toBase64Url(auth) }
  const decrypt = async (body: Uint8Array) => {
    const view = new DataView(body.buffer, body.byteOffset)
    const salt = body.slice(0, 16)
    const idLength = body[20]
    const asPublic = body.slice(21, 21 + idLength)
    const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, [])
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, pair.privateKey, 256))
    const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...publicKey, ...asPublic])
    const ikm = await hkdf(auth, secret, info, 32)
    const cek = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16), "AES-GCM", false, ["decrypt"])
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12) }, cek, body.slice(21 + idLength)))
    expect(view.getUint32(16)).toBe(4096)
    expect(plain.at(-1)).toBe(2)
    return decoder.decode(plain.slice(0, -1))
  }
  return { keys, decrypt }
}

export const vapidKeys = async (): Promise<Vapid> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey
  return {
    publicKey:  toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer)),
    privateKey: jwk.d!,
    subject:    "https://notunh.app"
  }
}

