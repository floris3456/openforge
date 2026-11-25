import { until } from "../../../client/test/fixture/wait"

export { until }

/**
 * Resolves once `condition` holds, polled every 10 ms against the wall clock as `until` is; after `timeout` ms fails
 * with `failure()`, written then, such as the frame last drawn. An error `condition` throws fails it as it is, never as
 * a timeout: a wait that only says it timed out hides what went wrong.
 */
export async function within(condition: () => boolean, timeout: number, failure: () => string) {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(failure())
    await Bun.sleep(10)
  }
}

/** The frame as plain words: borders and runs of spaces become one space, so text that wraps still matches. */
export function words(setup: { captureCharFrame: () => string }) {
  return setup.captureCharFrame().replace(/[┃│]/g, " ").replace(/\s+/g, " ")
}

/** Resolves once the frame, as `words`, matches; fails with the frame after `timeout` ms. */
export async function shows(
  setup: { captureCharFrame: () => string },
  match: (frame: string) => boolean,
  timeout = 5_000,
) {
  await within(
    () => match(words(setup)),
    timeout,
    () => `the frame did not match within ${timeout} ms:\n${setup.captureCharFrame()}`,
  )
}
