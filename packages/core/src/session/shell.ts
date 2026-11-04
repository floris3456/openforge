export * as SessionShell from "./shell.js"

import type { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import { Shell } from "../shell.js"
import { ShellResult } from "../shell/result.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"

/**
 * A `!` command whose end is not reported yet, kept from its start until its result is admitted. The command outlives
 * a stop in the tool runner, so the next service reports it as this one would have.
 */
export const Pending = Schema.Struct({
  sessionID: SessionSchema.ID,
  notificationID: SessionMessage.ID,
  shell: Shell.Info,
})
export type Pending = typeof Pending.Type
export const PREFIX = "session.shell/"
export const key = (id: Shell.ID) => PREFIX + id
export const encode = (pending: Pending) => JSON.stringify(Schema.encodeSync(Pending)(pending))
export const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Pending))

export const start = Effect.fn("SessionShell.start")(function* (input: { session: Session.Info; command: string }) {
  const instances = yield* Instance.Service
  const shell = yield* Plugin.awaitActivation.pipe(Effect.andThen(Shell.Service), instances.provide(input.session))
  const info = yield* shell.create({
    command: input.command,
    cwd: input.session.location.directory,
    timeout: 0,
    metadata: { sessionID: input.session.id, background: true },
  })
  return follow(shell, info)
})

/** A `!` command an earlier service started, followed again: still running in the tool runner, or finished. */
export const resume = Effect.fn("SessionShell.resume")(function* (input: { session: Session.Info; shell: Shell.Info }) {
  const instances = yield* Instance.Service
  const shell = yield* Plugin.awaitActivation.pipe(Effect.andThen(Shell.Service), instances.provide(input.session))
  const info = yield* shell.get(input.shell.id).pipe(Effect.orElseSucceed(() => input.shell))
  return follow(shell, info)
})

// Keep completion tied to the original shell even if the Session moves.
const follow = (shell: Shell.Interface, info: Shell.Info) => ({
  info,
  result: shell.result(info).pipe(
    Effect.catchTag("Shell.RunnerStoppedError", (error) =>
      Effect.succeed({
        info: { ...info, status: "killed" as const, time: { ...info.time, completed: Date.now() } },
        capture: { output: error.message, truncated: false },
      }),
    ),
  ),
  output: shell
    .output(info.id, { limit: 1024 * 1024 })
    .pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(ShellResult.unavailable))),
})
