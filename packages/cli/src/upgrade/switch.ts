// Switching the release in use, one switch at a time across every openforge process, through a lock in the data
// folder. A service that can pause (0.1.0 and later) is paused first: it stops starting model calls and tools, and
// every chat rests at a step boundary recorded in the database. If that takes longer than 2 minutes the service opens
// again by itself, and the switch tries again once the work it reported has finished. The switch then stops the
// service, copies the database next to the release it leaves, points `current` at the new release, starts it paused,
// checks within 10 s that it answers with the new version and reads its database, and resumes it: every chat
// continues where it rested. If anything fails after the stop it points `current` back, restores the copy, and starts
// and resumes the old release, so the chats continue there. A service from before 0.1.0 cannot pause; the switch
// then waits until no chat is running, as those releases did.

import { Service, type Endpoint } from "@opencode/client/effect/service"
import { ClientError, describeWork, OpenCode, type ContinuityWork, type OpenCodeEvent } from "@opencode/client/promise"
import { launchService, type ServiceProcess } from "@opencode/client/service-launch"
import { EffectFlock } from "@opencode/util/effect-flock"
import { Logging } from "@opencode/util/observability/logging"
import { Deferred, Duration, Effect, Exit, Fiber, FileSystem, Option, Schedule, Schema } from "effect"
import path from "node:path"
import { Release, UpgradeError } from "./release"
import { ReleaseDatabase } from "./database"
import { ReleaseLayout } from "./layout"
import { SwitchLock } from "./switch-lock"
import { ReleaseVersion } from "./version"

export const checkTimeout = Duration.seconds(10)
export const pauseTimeout = Duration.minutes(2)

/**
 * Work a pause waits for: a step that has not reached a boundary, a running tool or a model call, with the title of
 * its chat once the switch has read it.
 */
export type Work = ContinuityWork & { readonly title?: string }

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
  /** How long the running service gets to pause; 2 minutes unless a test shortens it. */
  readonly pause?: Duration.Duration
}

export type Result =
  | { readonly type: "switched"; readonly from: string; readonly to: string }
  /** Not switched yet: the pause gave up while `waiting` ran, or a service that cannot pause runs a chat. */
  | { readonly type: "busy"; readonly waiting?: ReadonlyArray<Work> }
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

/** Whether `version`'s service can pause, start paused (`serve --paused`) and resume: 0.1.0 and later. */
export function pausable(version: string) {
  return ReleaseVersion.parse(version) !== undefined && !ReleaseVersion.newer("0.1.0-0", version)
}

/**
 * Switches from `from` to `to`, which must be installed; `restore` replaces the live database with another copy.
 * `onWaiting` hears what a pause in progress still waits for, each time that changes.
 */
export const run = Effect.fn("upgrade.switch.run")(function* (
  target: Target,
  input: {
    readonly from: string
    readonly to: string
    readonly restore?: string
    readonly onWaiting?: (waiting: ReadonlyArray<Work>) => void
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
      if (!(yield* fs.exists(ReleaseLayout.binary(target.layout, input.to))))
        return yield* fail(`openforge ${input.to} is not installed`)

      // Once the service has paused the switch runs to its end, even if this process is asked to exit meanwhile;
      // asked while it pauses, the service opens again.
      return yield* Effect.uninterruptibleMask((interruptible) =>
        Effect.gen(function* () {
          const held = yield* interruptible(hold(target, input.onWaiting ?? (() => {}), log))
          if (held.type === "busy") return { type: "busy" as const, ...(held.waiting ? { waiting: held.waiting } : {}) }
          const old = held.type === "paused" ? held.endpoint : undefined
          yield* log("stopping the background service")
          const stopped = yield* stop(target).pipe(Effect.exit)
          if (Exit.isFailure(stopped)) {
            // Not the new release's fault, so it is not remembered as bad. A paused service that is still there
            // carries on.
            if (old) yield* reopen(old)
            return yield* fail(`the background service did not stop: ${failureMessage(stopped)}`)
          }
          const existed = yield* fs.exists(target.database)
          const progress = { copied: false, starting: false }
          const switched = yield* Effect.gen(function* () {
            progress.copied = yield* ReleaseDatabase.copy(target.database, copyOf(target, input.from))
            if (input.restore) {
              yield* ReleaseDatabase.restore(input.restore, target.database)
              yield* log(
                `restored the database copy ${input.restore}; the database used until now is kept at ${copyOf(target, input.from)}`,
              )
            }
            yield* ReleaseLayout.point(target.layout, input.to)
            yield* log(`current now points at ${input.to}; starting its service`)
            progress.starting = true
            yield* resume(yield* start(target, input.to))
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
          // The chats that rested on the old release continue there.
          const restarted = yield* start(target, input.from).pipe(Effect.flatMap(resume), Effect.exit)
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

/**
 * Step 1: pauses the running service, reporting what it still waits for. `busy` when the pause gave up, or when a
 * service that cannot pause runs a chat; `legacy` when such a service runs none. Interrupted before it answers, the
 * service opens again.
 */
const hold = Effect.fnUntraced(function* (
  target: Target,
  onWaiting: (waiting: ReadonlyArray<Work>) => void,
  log: (message: string) => Effect.Effect<void, never, FileSystem.FileSystem>,
) {
  const endpoint = yield* Service.discover({ file: target.service.file })
  // Without a service nothing runs that a switch could cut short.
  if (!endpoint) return { type: "none" as const }
  const api = client(endpoint)
  const status = yield* Effect.tryPromise({
    try: (signal) => api.experimental.service.status({ signal }),
    catch: (cause) => cause,
  }).pipe(Effect.exit)
  if (Exit.isFailure(status)) {
    // A service without the pause routes is from before 0.1.0. One that does not answer them cannot pause either;
    // both are switched as those releases were, once no chat runs, rather than cutting a chat short.
    const error = Option.getOrUndefined(Exit.findErrorOption(status))
    if (!(yield* busy(target))) return { type: "legacy" as const }
    yield* log(
      missing(error)
        ? "the running service cannot pause; switching once no chat is running"
        : `the running service did not say whether it can pause (${errorText(error)}); switching once no chat is running`,
    )
    return { type: "busy" as const }
  }
  const timeout = target.pause ?? pauseTimeout
  yield* log(`pausing the background service (at most ${Duration.format(timeout)})`)
  const titled = titles(api)
  const live = yield* Deferred.make<void>()
  const watching = yield* Effect.tryPromise(async (signal) => {
    for await (const event of api.event.subscribe({ types: ["service.pausing"], signal })) {
      Deferred.doneUnsafe(live, Effect.void)
      if (event.type === "service.pausing") onWaiting(await titled(event.data.waiting, signal))
    }
  }).pipe(Effect.ensuring(Deferred.done(live, Exit.void)), Effect.ignore, Effect.forkChild({ startImmediately: true }))
  // The first report of what it waits for comes right after the pause starts; listen before asking.
  yield* Deferred.await(live).pipe(Effect.timeoutOption("2 seconds"))
  const result = yield* Effect.tryPromise({
    try: (signal) => api.experimental.service.pause({ timeout: Duration.toMillis(timeout) }, { signal }),
    catch: (cause) => new UpgradeError({ reason: `the background service did not pause: ${errorText(cause)}` }),
  }).pipe(
    Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : reopen(endpoint))),
    Effect.ensuring(Fiber.interrupt(watching)),
  )
  if (result.paused) {
    yield* log(`paused; ${result.rested.length} chat(s) rest`)
    return { type: "paused" as const, endpoint }
  }
  const waiting = yield* Effect.promise((signal) => titled(result.waiting, signal))
  yield* log(
    `the pause gave up after ${Duration.format(timeout)} and the service carries on; switching once this has finished: ${describe(waiting)}`,
  )
  return { type: "busy" as const, waiting }
})

/** Adds each chat's title to the work a pause waits for; a chat is read once, and one that can't be read has none. */
function titles(api: ReturnType<typeof client>) {
  const known = new Map<string, Promise<string | undefined>>()
  const title = (sessionID: string, signal: AbortSignal) => {
    const found =
      known.get(sessionID) ??
      api.session.get({ sessionID }, { signal }).then(
        (session) => session.title || undefined,
        () => undefined,
      )
    known.set(sessionID, found)
    return found
  }
  return (waiting: ReadonlyArray<ContinuityWork>, signal: AbortSignal) =>
    Promise.all(
      waiting.map(async (work): Promise<Work> => {
        if (!work.sessionID) return work
        const name = await title(work.sessionID, signal)
        return name ? { ...work, title: name } : work
      }),
    )
}

/** Lifts a pause; a service that is gone or never paused is left alone. */
const reopen = (endpoint: Endpoint) =>
  Effect.tryPromise((signal) => client(endpoint).experimental.service.resume({ signal })).pipe(Effect.ignore)

/** Stops the managed service, handing persistent terminals to the next one. */
export const stop = Effect.fn("upgrade.switch.stop")(function* (target: Target) {
  yield* Service.stop({ file: target.service.file, pty: "handoff" })
})

/**
 * Starts the service from `current`, paused when the release can be, and requires it to pass the checks within 10 s:
 * it answers with `version`, reads its database and reaches the tool runner. The switch starts exactly one service
 * and stops it by its PID when a check fails, so no attempt of a failed release is left starting up once a rollback
 * restores the database.
 */
export const start = Effect.fn("upgrade.switch.start")(function* (target: Target, version: string) {
  const timeout = target.timeout ?? checkTimeout
  const paused = pausable(version)
  const env = {
    ...process.env,
    ...target.service.env,
    ...(yield* handoff(target.service.file)),
    [SwitchLock.variable]: "1",
  }
  // Started outside this process, which may replace itself with the new release and could then never reap it.
  const service = yield* Effect.try({
    try: () =>
      launchService(
        path.join(target.layout.current, Release.binary),
        ["serve", "--service", ...(paused ? ["--paused"] : [])],
        env,
      ),
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
  const checked = ready.pipe(
    Effect.flatMap((endpoint) =>
      check(endpoint, paused).pipe(
        Effect.as({ type: "ready" as const, endpoint, paused }),
        Effect.catch((error: Error) => Effect.succeed({ type: "failed" as const, reason: error.message })),
      ),
    ),
  )
  const outcome = yield* Effect.raceFirst(
    checked,
    Deferred.await(exited).pipe(Effect.map((reason) => ({ type: "exited" as const, reason }))),
  ).pipe(Effect.timeoutOption(timeout))
  const result = Option.getOrUndefined(outcome)
  if (result?.type === "ready") {
    // The service outlives this process; keep draining its stderr so it never blocks on a full pipe.
    child.stderr?.off("data", collect)
    child.stderr?.resume()
    return { endpoint: result.endpoint, paused: result.paused }
  }
  if (result?.type === "exited")
    return yield* Effect.fail(new Error(`The service of openforge ${version} exited (${result.reason}).${detail()}`))
  yield* kill(service, exited)
  if (result?.type === "failed")
    return yield* Effect.fail(new Error(`The service of openforge ${version} failed its check: ${result.reason}`))
  return yield* Effect.fail(
    new Error(
      `The service of openforge ${version} did not answer with that version within ${Duration.format(timeout)}.${detail()}`,
    ),
  )
})

/** Step 5, once the service answers with the expected version. A failure rolls the switch back. */
const check = Effect.fnUntraced(function* (endpoint: Endpoint, paused: boolean) {
  // The service opens and migrates its database before it answers at all; this read proves it can use it.
  yield* Effect.tryPromise({
    try: (signal) => client(endpoint).session.list({ limit: 1 }, { signal }),
    catch: (cause) => new Error(`it could not read its database: ${errorText(cause)}`),
  })
  // The tool runner came with the pause, in 0.1.0; an earlier release has neither.
  if (paused) yield* runnerReachable(endpoint)
})

/**
 * Step 5's last check: every tool runner holding commands answers the new service, so those commands reach the same
 * tool calls after the resume. Runs while the service is still paused, within the 10 s of the check; a failure rolls
 * the switch back.
 */
export const runnerReachable = Effect.fnUntraced(function* (endpoint: Endpoint): Effect.fn.Return<void, Error> {
  const status = yield* Effect.tryPromise({
    try: (signal) => client(endpoint).experimental.service.status({ signal }),
    catch: (cause) => new Error(`it did not say whether it reaches the tool runners: ${errorText(cause)}`),
  })
  const lost = (status.runners ?? []).filter((runner) => !runner.reachable)
  if (lost.length === 0) return
  return yield* Effect.fail(
    new Error(
      `it can't reach the tool runner of ${lost
        .map((runner) => `openforge ${runner.version}${runner.reason ? ` (${runner.reason})` : ""}`)
        .join(", ")}`,
    ),
  )
})

/** Step 6: every chat continues where it rested. A release that cannot pause was started running. */
const resume = Effect.fnUntraced(function* (started: { readonly endpoint: Endpoint; readonly paused: boolean }) {
  if (!started.paused) return
  const status = yield* Effect.tryPromise({
    try: (signal) => client(started.endpoint).experimental.service.resume({ signal }),
    catch: (cause) => new Error(`The new service did not resume: ${errorText(cause)}`),
  })
  if (status.state !== "running")
    return yield* Effect.fail(new Error(`The new service is ${status.state} after resuming.`))
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
 * For a service that cannot pause: waits until no chat runs on it. It listens for chats ending instead of polling.
 */
export const idle = Effect.fn("upgrade.switch.idle")(function* (target: Target) {
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
      }
      throw new Error("The event stream ended")
    })
  })
  // The service may restart while a chat runs; look it up again.
  yield* wait.pipe(Effect.retry(Schedule.spaced("1 second")))
})

// Events after which work a pause reported may have finished.
const ended = [
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.tool.success",
  "session.tool.failed",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const satisfies ReadonlyArray<OpenCodeEvent["type"]>

/**
 * After a pause gave up: waits until the work it reported has finished, listening to the service's events instead
 * of polling. A step counts as finished once its chat's step or execution ends, so the next step of the same chat
 * does not hold the switch back; a tool or model call once the service no longer lists it as running.
 */
export const finished = Effect.fn("upgrade.switch.finished")(function* (target: Target, waiting: ReadonlyArray<Work>) {
  let left = [...waiting]
  const wait = Effect.gen(function* () {
    const endpoint = yield* Service.discover({ file: target.service.file })
    if (!endpoint) return
    const api = client(endpoint)
    yield* Effect.tryPromise({
      try: async (signal) => {
        // The stream opens with server.connected, so the first check runs once the subscription is live.
        for await (const event of api.event.subscribe({ types: [...ended], signal })) {
          const sessionID = "sessionID" in event.data ? event.data.sessionID : undefined
          if (event.type.startsWith("session.execution.")) left = left.filter((work) => work.sessionID !== sessionID)
          if (event.type.startsWith("session.step."))
            left = left.filter((work) => work.sessionID !== sessionID || work.kind === "tool")
          const running = (await api.experimental.service.status({ signal })).waiting
          left = left.filter((work) => running.some((item) => same(item, work)))
          if (left.length === 0) return
        }
        throw new Error("The event stream ended")
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(
      // A service that cannot pause took over; the next attempt finds out.
      Effect.catchIf(missing, () => Effect.void),
    )
  })
  // The service may restart meanwhile; look it up again.
  yield* wait.pipe(Effect.retry(Schedule.spaced("1 second")))
})

/** `a reply in "Fix the tests", webfetch in "Docs"`: what a pause waits for, for logs and the command line. */
export function describe(waiting: ReadonlyArray<Work>) {
  if (waiting.length === 0) return "nothing"
  return describeWork(waiting, (sessionID) => waiting.find((work) => work.sessionID === sessionID)?.title)
}

function same(left: Work, right: Work) {
  return left.sessionID === right.sessionID && left.kind === right.kind && left.name === right.name
}

/** The service has no such route: a release from before 0.1.0, which cannot pause. */
function missing(error: unknown) {
  return (
    error instanceof ClientError &&
    error.reason === "UnexpectedStatus" &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "status" in error.cause &&
    error.cause.status === 404
  )
}

function client(endpoint: Endpoint) {
  return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
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
