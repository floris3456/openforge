export * as ShellInProcess from "./in-process.js"

import { rm } from "node:fs/promises"
import type { RunnerClient } from "@opencode/runner/client"
import { RunnerOutput } from "@opencode/runner/output"
import { RunnerProtocol } from "@opencode/runner/protocol"
import type { Location } from "@opencode/schema/location"
import type { Shell } from "@opencode/schema/shell"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { AppProcess } from "@opencode/util/process"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Queue, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { Environment } from "../environment/index.js"
import { ShellRunner } from "./runner.js"
import type { ShellWrap } from "./wrap.js"

const KILL_AFTER = Duration.millis(RunnerProtocol.KILL_AFTER)

export type Input = {
  readonly info: Shell.Info
  readonly location: Location.Ref
  readonly command: ShellWrap.Command
  /** Milliseconds since the epoch. */
  readonly deadline: number | undefined
  readonly sandboxNote?: string
}

/**
 * Runs a command from this service instead of the tool runner: a workspace's commands run in the workspace's own
 * environment, and Windows has no tool runner. Such a command ends with the service. Returns once it has started.
 */
export const start = Effect.fnUntraced(function* (input: Input) {
  const ready = yield* Deferred.make<Shell.Info, AppProcess.AppProcessError>()
  yield* run(input, ready).pipe(
    // Whatever stops it before it has started fails the start instead of leaving it waiting.
    Effect.onError((cause) => Deferred.fail(ready, failure(input, Cause.squash(cause)))),
    Effect.scoped,
    Effect.forkDetach({ startImmediately: true }),
  )
  return yield* Deferred.await(ready)
})

const failure = (input: Input, cause: unknown) =>
  cause instanceof AppProcess.AppProcessError
    ? cause
    : new AppProcess.AppProcessError({ command: input.info.command, cause })

const run = Effect.fnUntraced(function* (
  input: Input,
  ready: Deferred.Deferred<Shell.Info, AppProcess.AppProcessError>,
) {
  const environment = yield* Environment.Service
  const runner = yield* ShellRunner.Service
  const scope = yield* Effect.scope
  const id = input.info.id
  // Nothing runs when its output can't be kept; one that can't start leaves no file, as in the runner.
  const writer = yield* Effect.try({ try: () => new RunnerOutput.Writer(input.info.file), catch: (cause) => cause })
  yield* Effect.addFinalizer(() => Effect.sync(() => writer.close()))
  const handle = yield* environment.spawner
    .spawn(
      ChildProcess.make(input.command.argv[0], input.command.argv.slice(1), {
        cwd: input.command.cwd,
        env: input.command.env,
        stdin: "ignore",
        detached: process.platform !== "win32",
        forceKillAfter: KILL_AFTER,
      }),
    )
    .pipe(
      Effect.tapError(() =>
        Effect.tryPromise(() => rm(input.info.file, { force: true })).pipe(
          Effect.ignore({ log: "Warn", message: "cannot remove the output of a shell command that did not start" }),
        ),
      ),
    )

  let reason: "timeout" | "killed" | undefined
  let ended = false
  let lost = false
  let timer: Fiber.Fiber<void> | undefined
  // Completed and replaced by every append and by the end, so a watcher that found nothing new waits for the next.
  let changed = Deferred.makeUnsafe<void>()
  const wake = () => {
    Deferred.doneUnsafe(changed, Exit.void)
    changed = Deferred.makeUnsafe<void>()
  }
  // Detached, so interrupting whoever asked neither cancels the kill nor waits for the process to die.
  const kill = handle
    .kill({ forceKillAfter: KILL_AFTER })
    .pipe(Effect.ignore({ log: "Warn", message: "cannot stop a shell command" }), Effect.forkDetach, Effect.asVoid)
  const arm = (at: number | null) =>
    Effect.gen(function* () {
      if (timer) yield* Fiber.interrupt(timer)
      timer = undefined
      if (at === null) return
      timer = yield* Effect.sleep(Duration.millis(Math.max(0, at - Date.now()))).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            reason ??= "timeout"
            return kill
          }),
        ),
        Effect.forkIn(scope),
      )
    })
  // Live output until the command ends; ShellRunner reads what is left from the finished file.
  const follow = (offset: number) =>
    Stream.callback<RunnerClient.WatchEvent>((queue) =>
      Effect.gen(function* () {
        let cursor = offset
        while (!ended) {
          const next = changed
          const chunk = writer.read(cursor)
          if (!chunk) {
            yield* Deferred.await(next)
            continue
          }
          cursor = chunk.offset + chunk.data.length
          yield* Queue.offer(queue, { type: "output", offset: chunk.offset, data: chunk.data, size: writer.size })
        }
        yield* Queue.end(queue)
      }),
    )
  // A full disk loses output, not the command, as in the runner; only the first loss is logged.
  const append = (chunk: Uint8Array) =>
    Effect.try({ try: () => writer.append(chunk), catch: (cause) => cause }).pipe(
      Effect.catch((cause) => {
        if (lost) return Effect.void
        lost = true
        return Effect.logWarning("cannot write a shell command's output, so some of it is lost", { id, cause })
      }),
      Effect.ensuring(Effect.sync(wake)),
    )

  const started = { ...input.info, pid: handle.pid }
  const report = yield* runner.attach({
    info: started,
    location: input.location,
    sandboxNote: input.sandboxNote,
    control: {
      signal: () =>
        Effect.suspend(() => {
          reason ??= "killed"
          return kill
        }),
      deadline: arm,
      // Once it has ended, ShellRunner reads the finished file instead.
      read: (offset, limit) =>
        Effect.sync(() => {
          if (ended) return undefined
          const chunk = writer.read(offset, limit)
          return chunk
            ? { offset: chunk.offset, data: chunk.data, size: writer.size }
            : { offset: Math.min(offset, writer.size), data: Buffer.alloc(0), size: writer.size }
        }),
      watch: follow,
    },
  })
  yield* arm(input.deadline ?? null)
  yield* Deferred.succeed(ready, started)

  // Reported once: by its end, or as failed when following it fails.
  let reported = false
  const end = (outcome: Pick<ShellRunner.Ended, "status" | "code" | "signal" | "error" | "layout">) =>
    Effect.suspend(() => {
      if (reported) return Effect.void
      reported = true
      return report({ ...outcome, ended: Date.now(), size: writer.size, lines: writer.lines })
    })
  yield* Effect.gen(function* () {
    const [status] = yield* Effect.all(
      [
        handle.exitCode.pipe(
          Effect.map((code): { code?: number; signal?: string } => ({ code })),
          Effect.catch((error) =>
            Effect.succeed<{ code?: number; signal?: string }>({
              signal: error.cause instanceof CrossSpawnSpawner.KilledBySignal ? error.cause.signal : undefined,
            }),
          ),
        ),
        handle.all.pipe(
          Stream.runForEach(append),
          Effect.ignore({ log: "Warn", message: "cannot read a shell command's output" }),
        ),
      ],
      { concurrency: 2 },
    )
    if (timer) yield* Fiber.interrupt(timer)
    ended = true
    wake()
    const layout = yield* Effect.try({ try: () => writer.finish(), catch: (cause) => cause }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("cannot put a shell command's output in order, so only its start can be read", {
          id,
          cause,
        }).pipe(Effect.as(writer.layout)),
      ),
    )
    yield* end({
      status: reason ?? "exited",
      ...(status.code !== undefined ? { code: status.code } : {}),
      ...(status.signal !== undefined ? { signal: status.signal } : {}),
      ...(layout ? { layout } : {}),
    })
  }).pipe(
    Effect.onError((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : end({
            status: "failed",
            error: `the command could not be followed: ${RunnerProtocol.messageOf(Cause.squash(cause))}`,
          }),
    ),
  )
})
