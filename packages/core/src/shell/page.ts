export * as ShellPage from "./page.js"

import { isUtf8 } from "node:buffer"
import { Effect } from "effect"

/** Bytes of a command's output from a cursor on; `cursor` is the logical offset after them, `size` the output's. */
export type Read = {
  readonly data: Buffer
  readonly cursor: number
  readonly size: number
  readonly truncated: boolean
}

const continuation = (byte: number) => (byte & 0xc0) === 0x80

/** The character that starts before `cut` and ends after it, when `bytes` has a UTF-8 lead byte for one there. */
function straddling(bytes: Buffer, from: number, cut: number) {
  for (let start = cut - 1; start >= Math.max(from, cut - 3); start--) {
    const lead = bytes[start]
    if (continuation(lead)) continue
    if (lead < 0xc2 || lead > 0xf4) return
    const end = start + (lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4)
    return end > cut ? { start, end } : undefined
  }
}

/**
 * Reads a page of output that starts and ends on whole UTF-8 characters, so that decoding pages one by one gives
 * the same text as decoding all of it. The bytes of a character the cursor falls inside belong to the page before.
 * A character crossing the limit goes to the next page, unless it is the page's first, which then runs up to three
 * bytes past the limit. A valid start of a character at the end of a running command's output waits for the rest;
 * bytes that can't become a character are passed on, and decode as U+FFFD.
 */
export const whole = Effect.fnUntraced(function* <E>(
  read: (cursor: number, limit: number) => Effect.Effect<Read | undefined, E>,
  cursor: number,
  limit: number,
  running: boolean,
) {
  const first = yield* read(cursor, limit)
  if (!first) return undefined
  let from = 0
  while (from < Math.min(3, first.data.length) && continuation(first.data[from])) from++
  const cut = first.data.length
  const char = straddling(first.data, from, cut)
  const page = (data: Buffer, end: number) => ({ ...first, data, cursor: first.cursor + end - cut })
  if (!char) return page(first.data.subarray(from), cut)
  let bytes = first.data
  if (first.cursor < first.size) {
    const more = yield* read(first.cursor, char.end - cut)
    if (more && !more.truncated) bytes = Buffer.concat([bytes, more.data])
  }
  if (char.end <= bytes.length) {
    if (!isUtf8(bytes.subarray(char.start, char.end))) return page(first.data.subarray(from), cut)
    return char.start > from
      ? page(bytes.subarray(from, char.start), char.start)
      : page(bytes.subarray(from, char.end), char.end)
  }
  const live = running && first.cursor + bytes.length - cut >= first.size
  if (live && new TextDecoder().decode(bytes.subarray(char.start), { stream: true }) === "")
    return page(bytes.subarray(from, char.start), char.start)
  return page(first.data.subarray(from), cut)
})
