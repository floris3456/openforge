import { until } from "../../../client/test/fixture/wait"

export { until }

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
  await until(() => match(words(setup)), timeout).catch(() => {
    throw new Error(`the frame did not match within ${timeout} ms:\n${setup.captureCharFrame()}`)
  })
}
