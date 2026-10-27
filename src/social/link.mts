// The code one device shows and another types or scans to link them (worker/social.mts): eight letters and digits
// from an alphabet without 0, O, 1, I or L, shown in two halves. Read back forgivingly, whatever the case and
// whatever's between the halves

export const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
export const LENGTH = 8

/** ms a code lasts */
export const LINK_TTL = 2 * 60_000

/** A code from some random bytes, one each, as "ABCD-EFGH" */
export const codeOf = (bytes: Uint8Array) =>
  shown([...bytes.slice(0, LENGTH)].map(byte => ALPHABET[byte % ALPHABET.length]).join(""))

/** A code as it's shown: its two halves apart */
export const shown = (code: string) =>
  `${code.slice(0, LENGTH / 2)}-${code.slice(LENGTH / 2)}`

/** A code as typed or scanned, as the Worker keys it, or none for anything that isn't one */
export const parseCode = (text: string) => {
  const code = text.toUpperCase().replace(/[^0-9A-Z]/g, "")
  return code.length === LENGTH && [...code].every(char => ALPHABET.includes(char)) ? code : undefined
}

/** The link a QR of a code opens: the map, which asks whoever scans it to approve */
export const linkUrl = (origin: string, code: string) =>
  `${origin}/map/#link=${parseCode(code) ?? code}`
