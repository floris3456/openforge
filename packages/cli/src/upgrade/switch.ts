// Switching the release in use: one switch at a time across every openforge process, through a lock in the
// data folder. A switch stops the background service, copies the database next to the release it leaves,
// points `current` at the new release, starts the service on it and checks within 10 s that it answers with
// the new version. If that start or check fails it points `current` back, restores the copy and starts the
// old release again.

import { Service, type Endpoint } from "@opencode/client/effect/service"
import { OpenCode } from "@opencode/client/promise"
import { launchService, type ServiceProcess } from "@opencode/client/service-launch"
import { EffectFlock } from "@opencode/util/effect-flock"
import { Logging } from "@opencode/util/observability/logging"
import { Deferred, Duration, Effect, Exit, FileSystem, Option, Schedule, Schema } from "effect"
import path from "node:path"
import { Release, UpgradeError } from "./release"
import { ReleaseDatabase } from "./database"
import { ReleaseLayout } from "./layout"
import { SwitchLock } from "./switch-lock"

export const checkTimeout = Duration.seconds(10)

export type Target = {
  readonly layout: ReleaseLayout.Layout
  /** The live database file. */
  readonly database: string
  /** The managed service's registration file and the environment it is started with. */
  readonly service: { readonly file: string; readonly env?: Readonly<Record<string, string>> }
  /** Append-only log of switch attempts, named in failure messages. */
  readonly log: string
  /** How long a started service gets to answer with its version; 10 s unless a test shortens it. */
  readonly timeout?: Duration.Duration
}

export type Result =
  | { readonly type: "switched"; readonly from: string; readonly to: string }
  | { readonly type: "busy" }
  | { readonly type: "unchanged"; readonly version: string }
  | {
      readonly type: "rolled-back"
      readonly from: string
      readonly to: string
      readonly reason: string
      /** Whether the old release answered again after the rollback. */
      readonly restored: boolean
    }

/** The database copy made in `version`'s folder when openforge last switched away from it. */
export function copyOf(target: Target, version: string) {
  return path.join(ReleaseLayout.folder(target.layout, version), path.basename(target.database))
}

/**
 * Switches from `from` to `to`, which must be installed. `busy` is asked again once the lock is held, since a chat
 * may have started while this process waited for it; `restore` replaces the live database with another copy.
 */
export const run = Effect.fn("upgrade.switch.run")(function* (
  target: Target,
  input: {
    readonly from: string
    readonly to: string
    readonly busy: Effect.Effect<boolean, never, FileSystem.FileSystem>
    readonly restore?: string
  },
) {
  const flock = yield* EffectFlock.Service
  const fs = yield* FileSystem.FileSystem
  const log = (message: string) => note(target, input, message)
  // A failure that changed nothing; `from` stays in use.
  const fail = (reason: string) => Effect.fail(new UpgradeError({ reason }))
  yield* Logging.trim(target.log, { max: 1024 * 1024, keep: 512 * 1024 }).pipe(Effect.ignore)
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* flock
        .acquire(SwitchLock.key, target.layout.locks, { timeoutMs: Duration.toMillis(SwitchLock.timeout) })
        .pipe(Effect.catch(() => fail("another openforge process is still switching releases")))
      const current = yield* ReleaseLayout.current(target.layout)
      if (current === input.to) return { type: "unchanged" as const, version: input.to }
      if (current !== input.from)
        return yield* fail(`openforge changed from ${input.from} to ${current ?? "nothing"} meanwhile`)
      if (yield* input.busy) return { type: "busy" as const }
      if (!(yield* fs.exists(ReleaseLayout.binary(target.layout, input.to))))
        return yield* fail(`openforge ${input.to} is not installed`)

      // Once the service is stopped the switch runs to its end, even if this process is asked to exit meanwhile.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* log("stopping the background service")
          // Not the new release's fault, so it is not remembered as bad.
          yield* stop(target).pipe(
            Effect.catch((error) => fail(`the background service did not stop: ${error.message}`)),
          )
          const existed = yield* fs.exists(target.database)
          const progress = { copied: false, starting: false }
          const switched = yield* Effect.gen(function* () {
            progress.copied = yield* ReleaseDatabase.copy(target.database, copyOf(target, input.from))
            if (input.restore) yield* ReleaseDatabase.restore(input.restore, target.database)
            yield* ReleaseLayout.point(target.layout, input.to)
            yield* log(`current now points at ${input.to}; starting its service`)
            progress.starting = true
            yield* start(target, input.to)
          }).pipe(Effect.exit)
          if (Exit.isSuccess(switched)) {
            yield* log(`switched; the service reports ${input.to}`)
            yield* ReleaseLayout.clearBad(target.layout, input.to)
            const removed = yield* ReleaseLayout.prune(target.layout, [input.to, input.from])
            if (removed.length) yield* log(`removed old releases ${removed.join(", ")}`)
            return { type: "switched" as const, from: input.from, to: input.to }
          }

          const reason = failureMessage(switched)
          yield* log(`failed: ${reason}`)
          yield* log(`rolling back to ${input.from}`)
          yield* stop(target).pipe(Effect.ignore)
          yield* ReleaseLayout.point(target.layout, input.from)
          if (progress.copied) yield* ReleaseDatabase.restore(copyOf(target, input.from), target.database)
          // Without a database before the switch, whatever the new release created goes. A database whose copy
          // failed was not touched yet.
          if (!existed) yield* ReleaseDatabase.remove(target.database)
          const restarted = yield* start(target, input.from).pipe(Effect.exit)
          yield* log(
            Exit.isSuccess(restarted)
              ? `rolled back; the service reports ${input.from}`
              : `rolled back, but ${input.from} did not start either: ${failureMessage(restarted)}`,
          )
          // Only a release whose own service failed is remembered as bad; a full disk is not its fault.
          if (progress.starting) yield* ReleaseLayout.markBad(target.layout, input.to, { reason, log: target.log })
          return {
            type: "rolled-back" as const,
            from: input.from,
            to: input.to,
            reason,
            restored: Exit.isSuccess(restarted),
          }
        }),
      )
    }),
  ).pipe(Effect.tapError((error) => log(`failed: ${error.message}`)))
})

/** Stops the managed service, handing persistent terminals to the next one. */
export const stop = Effect.fn("upgrade.switch.stop")(function* (target: Target) {
  yield* Service.stop({ file: target.service.file, pty: "handoff" })
})

/**
 * Starts the service from `current` and requires it to answer with `version` within 10 s. The switch starts exactly
 * one service and stops it by its PID when the check fails, so no attempt of a failed release is left starting up
 * once a rollback restores the database.
 */
export const start = Effect.fn("upgrade.switch.start")(function* (target: Target, version: string) {
  const timeout = target.timeout ?? checkTimeout
  const env = {
    ...process.env,
    ...target.service.env,
    ...(yield* handoff(target.service.file)),
    [SwitchLock.variable]: "1",
  }
  // Started outside this process, which may replace itself with the new release and could then never reap it.
  const service = yield* Effect.try({
    try: () => launchService(path.join(target.layout.current, Release.binary), ["serve", "--service"], env),
    catch: (cause) => new Error(`Could not start openforge ${version}: ${String(cause)}`),
  })
  const child = service.launcher
  let stderr = ""
  const collect = (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-8_192)
  }
  child.stderr?.on("data", collect)
  const exited = yield* Deferred.make<string>()
  child.once("error", (cause) => Deferred.doneUnsafe(exited, Effect.succeed(cause.message)))
  void service.exited.then(() =>
    Deferred.doneUnsafe(
      exited,
      Effect.succeed(service.signalCode ?? (service.exitCode === null ? "status unknown" : `code ${service.exitCode}`)),
    ),
  )
  child.unref()
  const detail = () => (stderr.trim() ? `\n${stderr.trim()}` : "")

  const ready = Service.discover({ file: target.service.file, version }).pipe(
    Effect.flatMap((endpoint) => (endpoint ? Effect.succeed(endpoint) : Effect.fail(new Error("not ready")))),
    Effect.retry(Schedule.spaced("50 millis")),
  )
  const outcome = yield* Effect.raceFirst(
    ready.pipe(Effect.map((endpoint) => ({ type: "ready" as const, endpoint }))),
    Deferred.await(exited).pipe(Effect.map((reason) => ({ type: "exited" as const, reason }))),
  ).pipe(Effect.timeoutOption(timeout))
  const result = Option.getOrUndefined(outcome)
  if (result?.type === "ready") {
    // The service outlives this process; keep draining its stderr so it never blocks on a full pipe.
    child.stderr?.off("data", collect)
    child.stderr?.resume()
    return result.endpoint
  }
  if (result?.type === "exited")
    return yield* Effect.fail(new Error(`The service of openforge ${version} exited (${result.reason}).${detail()}`))
  yield* kill(service, exited)
  return yield* Effect.fail(
    new Error(
      `The service of openforge ${version} did not answer with that version within ${Duration.format(timeout)}.${detail()}`,
    ),
  )
})

const kill = Effect.fnUntraced(function* (service: ServiceProcess, exited: Deferred.Deferred<string>) {
  yield* Effect.sync(() => service.kill("SIGTERM"))
  if (Option.isSome(yield* Deferred.await(exited).pipe(Effect.timeoutOption("3 seconds")))) return
  yield* Effect.sync(() => service.kill("SIGKILL"))
  yield* Deferred.await(exited).pipe(Effect.timeoutOption("2 seconds"))
})

// `Service.stop({ pty: "handoff" })` leaves the persistent terminals' handoff ticket beside the registration; the
// next service adopts them from OPENCODE_PTY_HANDOFF, as `Service.ensure` passes it.
const Sidecar = Schema.Struct({ handoff: Schema.NullOr(Schema.Unknown), expiresAt: Schema.Number })
const decodeSidecar = Schema.decodeUnknownOption(Schema.fromJsonString(Sidecar))

const handoff = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const sidecar = (yield* fs.readFileString(`${file}.pty-handoff`).pipe(Effect.option)).pipe(
    Option.flatMap(decodeSidecar),
    Option.filter((value) => value.expiresAt > Date.now() && value.handoff !== null),
  )
  if (Option.isNone(sidecar)) return {}
  return { OPENCODE_PTY_HANDOFF: JSON.stringify(sidecar.value.handoff) }
})

/** Whether a chat is running on the local service; false when no service is running. */
export const busy = Effect.fn("upgrade.switch.busy")(function* (target: Target) {
  const endpoint = yield* Service.discover({ file: target.service.file })
  if (!endpoint) return false
  return yield* Effect.tryPromise((signal) => client(endpoint).session.active({ signal })).pipe(
    Effect.map((active) => Object.keys(active).length > 0),
    // A service that does not answer has no chat a switch could cut short.
    Effect.orElseSucceed(() => false),
  )
})

/**
 * Waits until no chat runs on the local service. It listens for chats ending instead of polling, and reports once
 * through `onBusy` when it has to wait.
 */
export const idle = Effect.fn("upgrade.switch.idle")(function* (target: Target, onBusy: () => void) {
  let announced = false
  const wait = Effect.gen(function* () {
    const endpoint = yield* Service.discover({ file: target.service.file })
    if (!endpoint) return
    const api = client(endpoint)
    yield* Effect.tryPromise(async (signal) => {
      const events = api.event.subscribe({
        types: ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"],
        signal,
      })
      // The stream opens with server.connected, so the first check runs once the subscription is live.
      for await (const _event of events) {
        if (Object.keys(await api.session.active({ signal })).length === 0) return
        if (!announced) {
          announced = true
          onBusy()
        }
      }
      throw new Error("The event stream ended")
    })
  })
  // The service may restart while a chat runs; look it up again.
  yield* wait.pipe(Effect.retry(Schedule.spaced("1 second")))
})

function client(endpoint: Endpoint) {
  return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
}

function failureMessage(exit: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(exit)) return ""
  const error = Option.getOrUndefined(Exit.findErrorOption(exit))
  if (error instanceof Error) return error.message
  return error === undefined ? "the service stopped unexpectedly" : String(error)
}

/** Adds a line about going from `from` to `to` to the upgrade log; never fails. */
export const note = (target: Target, input: { readonly from: string; readonly to: string }, message: string) =>
  append(target.log, `${input.from} -> ${input.to}: ${message}`)

const append = Effect.fnUntraced(
  function* (file: string, line: string) {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(file, `${new Date().toISOString()} ${line}\n`, { flag: "a" })
  },
  (effect) => Effect.ignore(effect),
)

export * as ReleaseSwitch from "./switch"
