export * as RunnerOutput from "./output.js"

import fs from "node:fs"
import { open, rename } from "node:fs/promises"

/** Bytes kept from the start of a command's output. */
export const HEAD = 1024 * 1024
/** The largest an output file gets: the first `HEAD` bytes, the dropped-bytes line and the newest bytes. */
export const LIMIT = 8 * 1024 * 1024
/** The most a single read or output frame carries. */
export const CHUNK = 64 * 1024

export type Bounds = { readonly head: number; readonly limit: number }
export const bounds: Bounds = { head: HEAD, limit: LIMIT }

/** How a finished file that dropped bytes is laid out: `head` bytes, a `marker` bytes long line, then the last `kept` bytes. */
export type Layout = { readonly head: number; readonly marker: number; readonly kept: number }

export const marker = (dropped: number) => `\n[... ${dropped} bytes of output dropped here ...]\n`

/** Where logical bytes from `start` lie in the file: `length` contiguous bytes at `position`. */
type Range = { readonly start: number; readonly position: number; readonly length: number }

const nothing = (start: number): Range => ({ start, position: 0, length: 0 })

/**
 * Writes a command's combined output to its file, never past `limit` bytes. Beyond `limit`, the bytes after `head`
 * wrap around in place as a ring holding the newest ones; `finish` puts them back in order behind a line saying how
 * many bytes were dropped. Offsets are logical: the n-th byte the command printed, dropped or not.
 */
export class Writer {
  size = 0
  lines = 0
  layout: Layout | undefined
  private fd: number
  private open = true

  constructor(
    readonly file: string,
    readonly limits: Bounds = bounds,
  ) {
    this.fd = fs.openSync(file, "w+", 0o600)
  }

  append(chunk: Uint8Array) {
    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1)) this.lines++
    const ring = this.limits.limit - this.limits.head
    let done = 0
    while (done < chunk.length) {
      const inHead = this.size < this.limits.head
      const slot = inHead ? 0 : (this.size - this.limits.head) % ring
      const room = inHead ? this.limits.head - this.size : ring - slot
      const length = Math.min(room, chunk.length - done)
      fs.writeSync(this.fd, chunk, done, length, inHead ? this.size : this.limits.head + slot)
      done += length
      this.size += length
    }
  }

  /** Up to `max` bytes from logical `offset` on, or later when those were dropped; undefined when there is nothing yet. */
  read(offset: number, max = CHUNK) {
    const range = this.layout ? locate(this.layout, this.size, offset) : this.running(offset)
    if (range.length <= 0 || !this.open) return undefined
    const data = Buffer.allocUnsafe(Math.min(max, range.length))
    const read = fs.readSync(this.fd, data, 0, data.length, range.position)
    return { offset: range.start, data: data.subarray(0, read) }
  }

  /** Puts the file in its final order. Returns the layout when bytes were dropped. */
  finish() {
    if (this.layout || this.size <= this.limits.limit) return this.layout
    const head = this.limits.head
    const settle = (length: number): number => {
      const next = Buffer.byteLength(marker(this.size - this.limits.limit + length))
      return next === length ? length : settle(next)
    }
    const kept = this.limits.limit - head - settle(Buffer.byteLength(marker(this.size - this.limits.limit)))
    const line = Buffer.from(marker(this.size - head - kept))
    const temporary = `${this.file}.${process.pid}.tmp`
    const target = fs.openSync(temporary, "w", 0o600)
    const buffer = Buffer.allocUnsafe(CHUNK)
    const copy = (position: number, length: number, to: number) => {
      for (let done = 0; done < length; ) {
        const read = fs.readSync(this.fd, buffer, 0, Math.min(CHUNK, length - done), position + done)
        if (read === 0) break
        fs.writeSync(target, buffer, 0, read, to + done)
        done += read
      }
    }
    copy(0, head, 0)
    fs.writeSync(target, line, 0, line.length, head)
    for (let offset = this.size - kept; offset < this.size; ) {
      const range = this.running(offset)
      copy(range.position, range.length, head + line.length + offset - (this.size - kept))
      offset += range.length
    }
    fs.closeSync(target)
    fs.closeSync(this.fd)
    fs.renameSync(temporary, this.file)
    this.fd = fs.openSync(this.file, "r")
    this.layout = { head, marker: line.length, kept }
    return this.layout
  }

  close() {
    if (!this.open) return
    this.open = false
    fs.closeSync(this.fd)
  }

  private running(offset: number): Range {
    const head = this.limits.head
    const ring = this.limits.limit - head
    const start = offset < head ? offset : Math.max(offset, this.size - ring)
    if (start >= this.size) return nothing(start)
    if (start < head) return { start, position: start, length: Math.min(head, this.size) - start }
    const slot = (start - head) % ring
    return { start, position: head + slot, length: Math.min(ring - slot, this.size - start) }
  }
}

/** Where logical bytes from `offset` lie in a finished file; bytes in the dropped part continue at the kept tail. */
export function locate(layout: Layout | undefined, size: number, offset: number): Range {
  if (offset >= size) return nothing(offset)
  if (!layout) return { start: offset, position: offset, length: size - offset }
  if (offset < layout.head) return { start: offset, position: offset, length: layout.head - offset }
  const tail = size - layout.kept
  const start = Math.max(offset, tail)
  return { start, position: layout.head + layout.marker + start - tail, length: size - start }
}

/**
 * Reads a finished output file from logical `offset`, at most `limit` bytes. A read that reaches the dropped part
 * returns the dropped-bytes line in its place and continues after it.
 */
export async function read(
  file: string,
  finished: { readonly size: number; readonly layout?: Layout },
  offset: number,
  limit: number,
) {
  const layout = finished.layout
  const skipping = layout !== undefined && offset >= layout.head && offset < finished.size - layout.kept
  const range = skipping
    ? { start: finished.size - layout.kept, position: layout.head, length: layout.marker + layout.kept }
    : locate(layout, finished.size, offset)
  const length = Math.min(limit, range.length)
  if (length <= 0) return { data: Buffer.alloc(0), cursor: Math.min(offset, finished.size), skipped: false }
  const handle = await open(file, "r")
  const data = await handle
    .read(Buffer.allocUnsafe(length), 0, length, range.position)
    .then((result) => result.buffer.subarray(0, result.bytesRead))
    .finally(() => handle.close())
  if (!skipping) return { data, cursor: range.start + data.length, skipped: false }
  const marked = Math.min(data.length, layout.marker)
  return { data, cursor: range.start + data.length - marked, skipped: true }
}

/** Replaces `file` with `text` in one rename, so a reader sees either the old or the whole new content. */
export async function writeAtomic(file: string, text: string) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  const handle = await open(temporary, "w", 0o600)
  await handle.writeFile(text).finally(() => handle.close())
  await rename(temporary, file)
}
