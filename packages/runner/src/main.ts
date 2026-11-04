export * as RunnerMain from "./main.js"

import { RunnerServer } from "./server.js"

/**
 * The runner as its own process (`openforge runner <directory>`). Returns the exit code: 0 once it exited because
 * nothing ran any more, 1 when another runner already serves the folder.
 */
export async function main(options: RunnerServer.Options) {
  const runner = await RunnerServer.serve(options).catch((cause: unknown) => {
    if (cause instanceof RunnerServer.LockedError) return undefined
    throw cause
  })
  if (!runner) return 1
  // Asked to stop, the runner stops its commands first; it has no terminal, so a hangup means nothing to it.
  const stop = () => void runner.shutdown()
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
  process.on("SIGHUP", () => {})
  await runner.closed
  return 0
}
