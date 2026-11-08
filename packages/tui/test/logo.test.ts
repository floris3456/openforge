import { expect, test } from "bun:test"
import { logo } from "../src/logo"

test("the wordmark's letters are all one height: the F stands no taller than the rest", () => {
  expect(logo.left).toHaveLength(logo.right.length)
  // A row only one half draws on stands that half's letters taller (the rename's F had a top bar above the letters).
  for (const [index, left] of logo.left.entries()) {
    expect(left.trim()).not.toBe("")
    expect(logo.right[index]!.trim()).not.toBe("")
  }
  // A capital F's shape (the owner's choice, 2026-11-08): the top bar, the stem, a shorter middle bar.
  expect(logo.right.map((line) => line.slice(0, 5))).toEqual(["█▀▀▀ ", "█▀▀  ", "▀    "])
})
