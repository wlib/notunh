// A QR code of some text (ISO/IEC 18004), as a square of dark and light modules, for the story image and the link
// between devices to draw. Byte mode, error correction M, versions 1 to 10, which hold up to 213 bytes, more than
// any link of ours: a short URL fits version 3. Small by taking only what those need: no alphanumeric or kanji
// modes, no other levels, and the tables below cut to ten versions

/** Data codewords a version holds at level M, with how its blocks are cut and how many EC codewords each gets */
const VERSIONS = [
  { capacity: 16,  ec: 10, blocks: [16] },
  { capacity: 28,  ec: 16, blocks: [28] },
  { capacity: 44,  ec: 26, blocks: [44] },
  { capacity: 64,  ec: 18, blocks: [32, 32] },
  { capacity: 86,  ec: 24, blocks: [43, 43] },
  { capacity: 108, ec: 16, blocks: [27, 27, 27, 27] },
  { capacity: 124, ec: 18, blocks: [31, 31, 31, 31] },
  { capacity: 154, ec: 22, blocks: [38, 38, 39, 39] },
  { capacity: 182, ec: 22, blocks: [36, 36, 36, 37, 37] },
  { capacity: 216, ec: 26, blocks: [43, 43, 43, 43, 44] }
]

/** Where a version's alignment patterns are centered, along each axis */
const ALIGNMENT = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]

/** The eight masks, each saying whether a module at a row and column is flipped */
const MASKS = [
  (r: number, c: number) => (r + c) % 2 === 0,
  (r: number)            => r % 2 === 0,
  (_: number, c: number) => c % 3 === 0,
  (r: number, c: number) => (r + c) % 3 === 0,
  (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r: number, c: number) => (r * c) % 2 + (r * c) % 3 === 0,
  (r: number, c: number) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r: number, c: number) => ((r + c) % 2 + (r * c) % 3) % 2 === 0
]

//#region GF(256) and Reed-Solomon

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
for (let i = 0, x = 1; i < 255; i++, x = x < 128 ? x << 1 : (x << 1) ^ 0x11d) {
  EXP[i] = x
  LOG[x] = i
}
for (let i = 255; i < 512; i++)
  EXP[i] = EXP[i - 255]

const multiply = (a: number, b: number) =>
  a && b ? EXP[LOG[a] + LOG[b]] : 0

/** The generator polynomial for some EC codewords, highest degree first */
export const generator = (degree: number) => {
  let poly = [1]
  for (let i = 0; i < degree; i++)
    poly = [...poly, 0].map((coefficient, j) => coefficient ^ (j ? multiply(poly[j - 1], EXP[i]) : 0))
  return poly
}

/** The remainder of some codewords, shifted by the degree, divided by the generator: their EC codewords */
export const remainder = (data: readonly number[], degree: number) => {
  const poly = generator(degree)
  const rest = new Array<number>(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ rest.shift()!
    rest.push(0)
    for (let i = 0; i < degree; i++)
      rest[i] ^= multiply(poly[i + 1], factor)
  }
  return rest
}

//#endregion

/** BCH check bits appended to some value's bits, for the format and version information */
const bch = (value: number, poly: number, bits: number) => {
  let rest = value << bits
  const top = 1 << (31 - Math.clz32(poly))
  for (let shift = 31 - Math.clz32(rest); shift >= 31 - Math.clz32(top); shift--)
    if (rest & (1 << shift))
      rest ^= poly << (shift - (31 - Math.clz32(top)))
  return (value << bits) | rest
}

/** The data codewords of some bytes at a version: mode, count, the bytes, terminator, and padding */
const codewords = (bytes: Uint8Array, version: number) => {
  const { capacity } = VERSIONS[version - 1]
  const bits: number[] = []
  const put = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--)
      bits.push((value >> i) & 1)
  }
  put(0b0100, 4)
  put(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes)
    put(byte, 8)
  put(0, Math.min(4, capacity * 8 - bits.length))
  while (bits.length % 8)
    bits.push(0)
  const words: number[] = []
  for (let i = 0; i < bits.length; i += 8)
    words.push(parseInt(bits.slice(i, i + 8).join(""), 2))
  for (let pad = 0xec; words.length < capacity; pad ^= 0xec ^ 0x11)
    words.push(pad)
  return words
}

/** The data cut into the version's blocks, each with its EC codewords, interleaved as they're placed */
export const interleaved = (data: readonly number[], version: number) => {
  const { ec, blocks } = VERSIONS[version - 1]
  let at = 0
  const cut = blocks.map(length => data.slice(at, at += length))
  const corrections = cut.map(block => remainder(block, ec))
  const out: number[] = []
  for (let i = 0; i < Math.max(...blocks); i++)
    for (const block of cut)
      if (i < block.length)
        out.push(block[i])
  for (let i = 0; i < ec; i++)
    for (const block of corrections)
      out.push(block[i])
  return out
}

export type Matrix = { size: number, modules: Uint8Array, version: number, mask: number }

/** The size of a version's symbol along each side */
export const sizeOf = (version: number) =>
  17 + 4 * version

/** The smallest version holding some bytes, or none past version 10 */
export const versionFor = (length: number) => {
  const index = VERSIONS.findIndex(({ capacity }, i) => capacity * 8 >= (i < 9 ? 12 : 20) + 8 * length)
  return index < 0 ? undefined : index + 1
}

/** A QR code of some text, UTF-8, masked by whichever of the eight reads best by the standard's penalties */
export const encode = (text: string): Matrix => {
  const bytes = new TextEncoder().encode(text)
  const version = versionFor(bytes.length)
  if (!version)
    throw new Error(`${bytes.length} bytes is too long for a QR code here`)
  const size = sizeOf(version)
  const modules = new Uint8Array(size * size)
  const isFunction = new Uint8Array(size * size)
  const set = (r: number, c: number, dark: boolean) => {
    modules[r * size + c] = dark ? 1 : 0
    isFunction[r * size + c] = 1
  }

  // Finder patterns with their separators, the timing patterns, the alignment patterns, and the dark module
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]])
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const [row, col] = [top + r, left + c]
        if (row >= 0 && row < size && col >= 0 && col < size)
          set(row, col, r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)))
      }
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  // Alignment patterns at every pair of centers but the three on the finders; those on the timing patterns stay
  const centers = ALIGNMENT[version - 1]
  const last = centers.at(-1)
  for (const row of centers)
    for (const col of centers)
      if (!((row === 6 || col === 6) && (row === last || col === last) || row === 6 && col === 6))
        for (let r = -2; r <= 2; r++)
          for (let c = -2; c <= 2; c++)
            set(row + r, col + c, Math.max(Math.abs(r), Math.abs(c)) !== 1)
  set(size - 8, 8, true)

  // Where the format bits go, reserved while the data is placed, and the version bits, which don't change by mask
  const formatAt = (i: number): [number, number][] =>
    i < 6 ? [[i, 8], [8, size - 1 - i]] : i < 8 ? [[i + 1, 8], [8, size - 1 - i]] : i === 8 ? [[8, 7], [size - 7, 8]] : [[8, 14 - i], [size - 15 + i, 8]]
  for (let i = 0; i < 15; i++)
    for (const [r, c] of formatAt(i))
      set(r, c, false)
  if (version >= 7) {
    const info = bch(version, 0x1f25, 12)
    for (let i = 0; i < 18; i++) {
      const dark = ((info >> i) & 1) === 1
      set(Math.floor(i / 3), size - 11 + (i % 3), dark)
      set(size - 11 + (i % 3), Math.floor(i / 3), dark)
    }
  }

  // The codewords in the zigzag up and down column pairs from the bottom right, skipping the timing column
  const data = interleaved(codewords(bytes, version), version)
  let bit = 0
  let isUpward = true
  for (let right = size - 1; right >= 1; right -= 2, isUpward = !isUpward) {
    if (right === 6)
      right--
    for (let i = 0; i < size; i++) {
      const row = isUpward ? size - 1 - i : i
      for (const col of [right, right - 1])
        if (!isFunction[row * size + col]) {
          modules[row * size + col] = (data[bit >> 3] >> (7 - (bit & 7))) & 1
          bit++
        }
    }
  }

  // Each mask's symbol, with its format bits, scored by the penalties; the lowest wins
  const masked = (mask: number) => {
    const out = new Uint8Array(modules)
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (!isFunction[r * size + c] && MASKS[mask](r, c))
          out[r * size + c] ^= 1
    const format = bch(mask, 0x537, 10) ^ 0x5412
    for (let i = 0; i < 15; i++)
      for (const [r, c] of formatAt(i))
        out[r * size + c] = (format >> i) & 1
    return out
  }
  let best: { mask: number, modules: Uint8Array, score: number } | undefined
  for (let mask = 0; mask < 8; mask++) {
    const out = masked(mask)
    const score = penalty(out, size)
    if (!best || score < best.score)
      best = { mask, modules: out, score }
  }
  return { size, modules: best!.modules, version, mask: best!.mask }
}

/** The standard's four penalties on a symbol: runs, blocks, finder-like patterns, and dark imbalance */
export const penalty = (modules: Uint8Array, size: number) => {
  const at = (r: number, c: number) => modules[r * size + c]
  const FINDER = [1, 0, 1, 1, 1, 0, 1]
  let score = 0
  // Along each row, then each column: runs of five or more alike, and finder-like patterns with light beside them
  for (const line of [at, (r: number, i: number) => at(i, r)])
    for (let r = 0; r < size; r++) {
      let count = 1
      for (let i = 1; i <= size; i++)
        if (i < size && line(r, i) === line(r, i - 1))
          count++
        else {
          if (count >= 5)
            score += count - 2
          count = 1
        }
      for (let i = 0; i + 7 <= size; i++)
        if (FINDER.every((bit, j) => line(r, i + j) === bit)) {
          const isLight = (from: number) => from >= 0 && from + 4 <= size && [0, 1, 2, 3].every(j => line(r, from + j) === 0)
          if (isLight(i - 4) || isLight(i + 7))
            score += 40
        }
    }
  for (let r = 0; r + 1 < size; r++)
    for (let c = 0; c + 1 < size; c++)
      if (at(r, c) === at(r, c + 1) && at(r, c) === at(r + 1, c) && at(r, c) === at(r + 1, c + 1))
        score += 3
  const dark = modules.reduce((sum, module) => sum + module, 0)
  return score + Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10
}

/** An SVG path of the dark modules, in module units, for drawing a matrix at any size */
export const pathOf = ({ size, modules }: Matrix) => {
  let path = ""
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (modules[r * size + c])
        path += `M${c} ${r}h1v1h-1z`
  return path
}
