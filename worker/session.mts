// The device's credential as a cookie the Worker sets: its id and secret, the same a device keeps in its own storage
// (src/reminders/browser/store.mts), so a device whose storage the browser cleared is still itself to the Worker and
// can take its id and secret back (GET /api/session). Set by the Worker, never by script, so Safari's seven-day cap
// on what script writes doesn't apply; HttpOnly, so script can't read or clear it; Secure over https; SameSite=Lax,
// and only sent to /api/. Its life is the most browsers keep a cookie, 400 days, renewed with every ask. Pure

/** The cookie's name */
export const COOKIE = "notunh-device"

/** 400 days in seconds, the longest Chrome keeps a cookie, and Safari's limit as WebKit has said it */
export const MAX_AGE = 400 * 24 * 60 * 60

/** A device id or secret, as the browser makes them: base64url */
const PART = /^[\w-]{16,200}$/

export type Credential = { device: string, secret: string }

/** The Set-Cookie header that keeps a device's credential, Secure where the request came over https */
export const cookieOf = ({ device, secret }: Credential, isSecure: boolean) =>
  `${COOKIE}=${device}.${secret}; Max-Age=${MAX_AGE}; Path=/api/; HttpOnly; SameSite=Lax${isSecure ? "; Secure" : ""}`

/** The Set-Cookie header that forgets it */
export const forgetCookie = (isSecure: boolean) =>
  `${COOKIE}=; Max-Age=0; Path=/api/; HttpOnly; SameSite=Lax${isSecure ? "; Secure" : ""}`

/** The device's credential from a Cookie header, if it holds one well formed, among any others */
export const credentialFrom = (header: string | undefined): Credential | undefined => {
  for (const pair of header?.split(";") ?? []) {
    const [name, value = ""] = pair.trim().split(/=(.*)/s)
    if (name !== COOKIE)
      continue
    const [device, secret, ...rest] = value.split(".")
    if (!rest.length && device && secret && PART.test(device) && PART.test(secret))
      return { device, secret }
  }
}
