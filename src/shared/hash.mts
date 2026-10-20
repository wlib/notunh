// The one name content goes by, in the scripts and everywhere else: its SHA-256. Under Node it streams through
// node:crypto a chunk at a time; anywhere else it's hashed whole with WebCrypto

/** Bytes, or text, or what a stream of either yields */
export type Chunks = Uint8Array | string | AsyncIterable<Uint8Array | string>

type Hash = { update: (data: Uint8Array | string) => unknown, digest: (encoding: "hex" | "base64url") => string }

const nodeCrypto = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule?.("node:crypto") as
  { createHash: (algorithm: "sha256") => Hash } | undefined

/** The SHA-256 of some bytes or text, or of everything a stream of them yields, in hex, or base64url */
export const contentHash = async (data: Chunks, encoding: "hex" | "base64url" = "hex") => {
  const chunks = typeof data === "string" || data instanceof Uint8Array ? [data] : data
  if (nodeCrypto) {
    const hash = nodeCrypto.createHash("sha256")
    for await (const chunk of chunks)
      hash.update(chunk)
    return hash.digest(encoding)
  }
  const parts: (Uint8Array<ArrayBuffer> | string)[] = []
  for await (const chunk of chunks)
    parts.push(typeof chunk === "string" ? chunk : new Uint8Array(chunk))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await new Blob(parts).arrayBuffer()))
  return encoding === "hex"
    ? Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
    : btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}
