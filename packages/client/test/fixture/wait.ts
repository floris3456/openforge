import type { Resender } from "../../src/promise"

/** Resolves once `condition` holds, for state that no event announces; fails after `timeout` ms of wall-clock time. */
export async function until(condition: () => boolean, timeout = 5_000, what = "the condition") {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} did not hold within ${timeout} ms`)
    await Bun.sleep(10)
  }
}

/** Resolves once `count` writes wait to be resent. */
export function waiting(resender: Resender, count: number) {
  return new Promise<void>((resolve) => {
    if (resender.pending() === count) return resolve()
    const stop = resender.watchPending((pending) => {
      if (pending !== count) return
      stop()
      resolve()
    })
  })
}
