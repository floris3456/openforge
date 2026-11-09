import { describe, expect, test } from "bun:test"
import { deflateSync, inflateSync } from "node:zlib"
import {
  cell,
  cells,
  imageID,
  imageIDs,
  LIMIT,
  passthrough,
  randomNumber,
  remove,
  transmit,
} from "../../src/image/placeholder"

// openforge (spec image-view, Proof): the bytes for a placeholder image through tmux. Kitty's graphics protocol,
// "Unicode placeholders": https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders

const codepoints = (text: string) => [...text].map((char) => char.codePointAt(0)!)

describe("the cells", () => {
  test("a cell is U+10EEEE with the row's, the column's and the high byte's diacritics", () => {
    // kitty's own example: row 0 is U+0305, row 1 U+030D, and 2 (a high byte) U+030E.
    expect(codepoints(cell(0, 0, 2))).toEqual([0x10eeee, 0x0305, 0x0305, 0x030e])
    expect(codepoints(cell(0, 1, 2))).toEqual([0x10eeee, 0x0305, 0x030d, 0x030e])
    expect(codepoints(cell(1, 0, 2))).toEqual([0x10eeee, 0x030d, 0x0305, 0x030e])
    expect(codepoints(cell(LIMIT - 1, LIMIT - 1, 255))).toEqual([0x10eeee, 0x1d244, 0x1d244, 0xa8e5])
  })

  test("a row's cells run from one column up to another", () => {
    const number = { index: 110, high: 7 }
    expect(cells(number, 3, 4, 7)).toBe(cell(3, 4, 7) + cell(3, 5, 7) + cell(3, 6, 7))
    expect(cells(number, 3, 4, 4)).toBe("")
  })

  test("there are 297 diacritics, so a placement has at most 297 rows and columns", () => {
    expect(LIMIT).toBe(297)
  })
})

describe("the numbers", () => {
  test("a number's colour is a cube index that is neither a grey nor one of the 16 basic colours", () => {
    const seen = new Set<number>()
    for (let draw = 0; draw < 2000; draw++) {
      const number = randomNumber()
      seen.add(number.index)
      expect(number.index).toBeGreaterThanOrEqual(16)
      expect(number.index).toBeLessThanOrEqual(231)
      const cube = number.index - 16
      const levels = [Math.floor(cube / 36), Math.floor(cube / 6) % 6, cube % 6]
      expect(levels.every((level) => level === levels[0])).toBe(false)
      expect(levels.every((level) => level === 0 || level === 5)).toBe(false)
      expect(number.high).toBeGreaterThanOrEqual(1)
      expect(number.high).toBeLessThanOrEqual(255)
    }
    // 216 cube colours less 6 greys and 6 basic colours.
    expect(seen.size).toBe(204)
  })

  test("numbers are drawn at random, so two TUIs in one terminal don't take each other's", () => {
    const first = randomNumber()
    const others = Array.from({ length: 20 }, () => randomNumber())
    expect(others.some((number) => number.index !== first.index || number.high !== first.high)).toBe(true)
    expect(randomNumber(() => 0)).toEqual({ index: 17, high: 1 })
    expect(randomNumber(() => 0.999999)).toEqual({ index: 230, high: 255 })
  })

  test("the image id is read from the colour as an index or as 24 bits, under the high byte", () => {
    // Index 110 is cube (2, 3, 4): 135, 175, 215.
    const number = { index: 110, high: 3 }
    expect(imageID(number, "index")).toBe(3 * 2 ** 24 + 110)
    expect(imageID(number, "rgb")).toBe(3 * 2 ** 24 + ((135 << 16) | (175 << 8) | 215))
  })

  test("written as an index, one id; written as 24 bits, both readings, since tmux may turn it back into the index", () => {
    const number = { index: 110, high: 3 }
    expect(imageIDs(number, true)).toEqual([imageID(number, "index")])
    expect(imageIDs(number, false)).toEqual([imageID(number, "index"), imageID(number, "rgb")])
  })
})

describe("the sequences", () => {
  const apc = /^\x1b_G([^;]*)(?:;(.*))?\x1b\\$/s

  test("an image is transmitted without a placement, quietly, in chunks of at most 4096, then placed virtually", () => {
    // Noise, which deflate can't shrink, so it takes several chunks.
    const rgba = crypto.getRandomValues(new Uint8Array(64 * 64 * 4))
    const deflated = deflateSync(rgba)
    const sequences = transmit(42, { width: 64, height: 64, deflated }, 8, 4)
    const parsed = sequences.map((sequence) => apc.exec(sequence)!)
    expect(parsed.every(Boolean)).toBe(true)
    const chunks = parsed.slice(0, -1)
    expect(chunks.length).toBe(Math.ceil(Buffer.from(deflated).toString("base64").length / 4096))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]![1]).toBe("a=t,q=2,f=32,o=z,s=64,v=64,i=42,m=1")
    chunks.slice(1, -1).forEach((chunk) => expect(chunk[1]).toBe("q=2,m=1"))
    expect(chunks.at(-1)![1]).toBe("q=2,m=0")
    chunks.forEach((chunk) => expect(chunk[2]!.length).toBeLessThanOrEqual(4096))
    chunks.slice(0, -1).forEach((chunk) => expect(chunk[2]!.length % 4).toBe(0))
    expect(inflateSync(Buffer.from(chunks.map((chunk) => chunk[2]).join(""), "base64"))).toEqual(Buffer.from(rgba))
    expect(parsed.at(-1)![1]).toBe("a=p,U=1,q=2,i=42,c=8,r=4")
    // No real placement anywhere (`a=T`), which would stay behind as a ghost when the cells move.
    expect(sequences.join("")).not.toContain("a=T")
  })

  test("a small image goes in one chunk", () => {
    const sequences = transmit(7, { width: 1, height: 1, deflated: deflateSync(new Uint8Array(4)) }, 1, 1)
    expect(sequences).toHaveLength(2)
    expect(apc.exec(sequences[0]!)![1]).toBe("a=t,q=2,f=32,o=z,s=1,v=1,i=7,m=0")
  })

  test("an image that goes is deleted with its data", () => {
    expect(remove(42)).toBe("\x1b_Ga=d,d=I,q=2,i=42\x1b\\")
  })

  test("tmux's passthrough wraps a sequence and doubles its ESCs", () => {
    expect(passthrough("\x1b_Ga=d,d=I,q=2,i=42\x1b\\")).toBe("\x1bPtmux;\x1b\x1b_Ga=d,d=I,q=2,i=42\x1b\x1b\\\x1b\\")
  })
})
