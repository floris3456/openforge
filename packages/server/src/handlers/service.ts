import { SessionContinuity } from "@opencode/core/continuity"
import { ShellRunner } from "@opencode/core/shell/runner"
import { Effect } from "effect"

/** `service.*` in the `server.experimental` group: the pause, status and resume a release switch drives. */
export const makeService = Effect.gen(function* () {
  const continuity = yield* SessionContinuity.Service
  const shells = yield* ShellRunner.Service

  return {
    // The tool runners found at start are reported only here.
    status: Effect.map(Effect.all([continuity.status, shells.runners]), ([status, runners]) => ({
      data: { ...status, runners },
    })),
    pause: (timeout: number | undefined) => Effect.map(continuity.pause({ timeout }), (data) => ({ data })),
    resume: Effect.map(continuity.resume, (data) => ({ data })),
  }
})
