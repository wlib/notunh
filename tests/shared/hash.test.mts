import { test, expect, vi } from "vitest"
import fc from "fast-check"
import { createHash } from "node:crypto"
import { Readable } from "node:stream"
import { contentHash } from "../../src/shared/hash.mts"

const chunks = fc.array(fc.oneof(fc.uint8Array({ maxLength: 64 }), fc.string({ maxLength: 64 })), { maxLength: 8 })
const joined = (parts: readonly (Uint8Array | string)[]) =>
  Buffer.concat(parts.map(part => typeof part === "string" ? Buffer.from(part) : part))

test("a stream's hash is the SHA-256 of all it yields, however it's cut, the same whole, and in hex or base64url", () =>
  fc.assert(fc.asyncProperty(chunks, async parts => {
    const whole = joined(parts)
    const hex = createHash("sha256").update(whole).digest("hex")
    expect(await contentHash(Readable.from(parts))).toBe(hex)
    expect(await contentHash(new Uint8Array(whole))).toBe(hex)
    expect(await contentHash(Readable.from(parts), "base64url")).toBe(Buffer.from(hex, "hex").toString("base64url"))
  }))
)

test("where there's no Node, as in a page or the Worker, WebCrypto gives the same hashes", async () => {
  vi.resetModules()
  vi.stubGlobal("process", { ...process, getBuiltinModule: undefined })
  try {
    const { contentHash: webHash } = await import("../../src/shared/hash.mts")
    await fc.assert(fc.asyncProperty(chunks, async parts => {
      expect(await webHash(Readable.from(parts))).toBe(await contentHash(Readable.from(parts)))
      expect(await webHash(Readable.from(parts), "base64url")).toBe(await contentHash(Readable.from(parts), "base64url"))
    }))
  }
  finally {
    vi.unstubAllGlobals()
  }
})
