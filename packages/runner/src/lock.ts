export * as RunnerLock from "./lock.js"

import fs from "node:fs"

const LOCK_EX = 2
const LOCK_NB = 4

type Flock = (fd: number, operation: number) => number

let flock: Promise<Flock | undefined> | undefined

// flock(2) through Bun's FFI: the kernel drops the lock when its holder dies, however it dies.
const load = () =>
  (flock ??= import("bun:ffi").then(
    (ffi) => {
      const names =
        process.platform === "darwin"
          ? ["libc.dylib"]
          : ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1", "libc.so"]
      for (const name of names) {
        try {
          const library = ffi.dlopen(name, { flock: { args: [ffi.FFIType.i32, ffi.FFIType.i32], returns: ffi.FFIType.i32 } })
          return (fd: number, operation: number) => library.symbols.flock(fd, operation)
        } catch {}
      }
      return undefined
    },
    // Outside Bun there is no flock; one runner per folder then rests on its socket alone.
    () => undefined,
  ))

export type Lock = { readonly release: () => void }

/** Takes the exclusive lock on `file` without waiting; undefined while another process holds it. */
export async function acquire(file: string): Promise<Lock | undefined> {
  const lock = await load()
  const fd = fs.openSync(file, "a", 0o600)
  if (lock && lock(fd, LOCK_EX | LOCK_NB) !== 0) {
    fs.closeSync(fd)
    return undefined
  }
  return { release: () => fs.closeSync(fd) }
}

/** Whether a live process holds the lock on `file`. */
export async function held(file: string) {
  if (!fs.existsSync(file)) return false
  const lock = await acquire(file)
  if (!lock) return true
  lock.release()
  return false
}
