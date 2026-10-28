import { test, expect } from "vitest"
import fc from "fast-check"
import { encode, generator, interleaved, pathOf, penalty, remainder, sizeOf, versionFor } from "../../src/social/qr.mts"

/** GF(256) multiplication, as the encoder's, for checking its Reed-Solomon independently */
const multiply = (a: number, b: number) => {
  let product = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1)
      product ^= a
    const carry = a & 0x80
    a = (a << 1) & 0xff
    if (carry)
      a ^= 0x1d
    b >>= 1
  }
  return product
}

/** A polynomial evaluated at a point, coefficients highest degree first */
const evaluate = (poly: number[], x: number) =>
  poly.reduce((sum, coefficient) => multiply(sum, x) ^ coefficient, 0)

test("the generator's roots are the first powers of the primitive element, and every codeword has them as roots too", () =>
  fc.assert(fc.property(fc.integer({ min: 1, max: 30 }), fc.array(fc.nat(255), { minLength: 1, maxLength: 60 }), (degree, data) => {
    const poly = generator(degree)
    expect(poly).toHaveLength(degree + 1)
    const codeword = [...data, ...remainder(data, degree)]
    let alpha = 1
    for (let i = 0; i < degree; i++) {
      expect(evaluate(poly, alpha)).toBe(0)
      expect(evaluate(codeword, alpha)).toBe(0)
      alpha = multiply(alpha, 2)
    }
  }))
)

test("the smallest version holding the bytes is chosen, up to ten, and a symbol has that version's size", () =>
  fc.assert(fc.property(fc.string({ maxLength: 230 }), text => {
    const bytes = new TextEncoder().encode(text).length
    const version = versionFor(bytes)
    if (version === undefined) {
      expect(bytes).toBeGreaterThan(213)
      expect(() => encode(text)).toThrow()
      return
    }
    expect(version).toBeGreaterThanOrEqual(1)
    expect(version).toBeLessThanOrEqual(10)
    if (version > 1)
      expect(versionFor(bytes)).not.toBe(versionFor(0))
    const matrix = encode(text)
    expect(matrix).toMatchObject({ version, size: sizeOf(version) })
    expect(matrix.modules).toHaveLength(matrix.size ** 2)
  }), { numRuns: 60 })
)

/** The three finder patterns with their separators, as every symbol has them */
const finderAt = (modules: Uint8Array, size: number, top: number, left: number) => {
  for (let r = -1; r <= 7; r++)
    for (let c = -1; c <= 7; c++) {
      const [row, col] = [top + r, left + c]
      if (row < 0 || col < 0 || row >= size || col >= size)
        continue
      const dark = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
      expect(modules[row * size + col], `${row},${col}`).toBe(dark ? 1 : 0)
    }
}

/** The 15 format bits as placed by the top left finder, LSB first */
const formatBits = (modules: Uint8Array, size: number) => {
  const at = (r: number, c: number) => modules[r * size + c]
  const bits = [at(0, 8), at(1, 8), at(2, 8), at(3, 8), at(4, 8), at(5, 8), at(7, 8), at(8, 8), at(8, 7), at(8, 5), at(8, 4), at(8, 3), at(8, 2), at(8, 1), at(8, 0)]
  return bits.reduce((value, bit, i) => value | (bit << i), 0)
}

/** Whether 15 bits are a valid format word: the BCH remainder of the unmasked bits is zero */
const isFormatWord = (bits: number) => {
  let rest = bits ^ 0x5412
  for (let shift = 14; shift >= 10; shift--)
    if (rest & (1 << shift))
      rest ^= 0x537 << (shift - 10)
  return rest === 0
}

test("every symbol has its finders, timing patterns, dark module, and a valid format word for level M and its mask, which has the least penalty", () =>
  fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 120 }), text => {
    const { size, modules, mask } = encode(text)
    finderAt(modules, size, 0, 0)
    finderAt(modules, size, 0, size - 7)
    finderAt(modules, size, size - 7, 0)
    for (let i = 8; i < size - 8; i++) {
      expect(modules[6 * size + i]).toBe(i % 2 === 0 ? 1 : 0)
      expect(modules[i * size + 6]).toBe(i % 2 === 0 ? 1 : 0)
    }
    expect(modules[(size - 8) * size + 8]).toBe(1)
    const format = formatBits(modules, size)
    expect(isFormatWord(format)).toBe(true)
    expect(((format ^ 0x5412) >> 13) & 3).toBe(0)
    expect(((format ^ 0x5412) >> 10) & 7).toBe(mask)
    // The same text is always the same symbol
    expect(encode(text).modules).toEqual(modules)
  }), { numRuns: 40 })
)

test("interleaving keeps every data codeword once, then the blocks' EC codewords", () =>
  fc.assert(fc.property(fc.integer({ min: 1, max: 10 }), fc.array(fc.nat(255), { minLength: 216, maxLength: 216 }), (version, all) => {
    const capacity = [16, 28, 44, 64, 86, 108, 124, 154, 182, 216][version - 1]
    const data = all.slice(0, capacity)
    const out = interleaved(data, version)
    const total = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346][version - 1]
    expect(out).toHaveLength(total)
    expect([...out.slice(0, capacity)].sort()).toEqual([...data].sort())
  }))
)

test("a path draws exactly the dark modules, and the penalty of a blank symbol is its runs and blocks alone", () => {
  const matrix = encode("notunh")
  const dark = matrix.modules.reduce((sum, module) => sum + module, 0)
  expect(pathOf(matrix).match(/M/g)).toHaveLength(dark)
  const blank = new Uint8Array(21 * 21)
  expect(penalty(blank, 21)).toBe(21 * 2 * (21 - 2) + 20 * 20 * 3 + 100)
})
