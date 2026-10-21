// Base64url without padding (RFC 4648 §5), as push keys, VAPID tokens and ids travel, over the btoa and atob every
// runtime has. Node's own scripts use Buffer instead (scripts/secrets.mts)

export const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

export const fromBase64Url = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0))

/** Some random bytes, base64url, as ids and secrets are made */
export const randomBase64Url = (bytes: number) =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
