export * as RunnerClient from "./client.js"

import { spawn } from "node:child_process"
import fs from "node:fs"
import { readFile } from "node:fs/promises"
import net from "node:net"
import { Cause, Deferred, Duration, Effect, Exit, Queue, Schedule, Schema, Scope, Stream } from "effect"
import { RunnerPaths } from "./paths.js"
import { RunnerProtocol } from "./protocol.js"

export class RunnerError extends Schema.TaggedError<RunnerError>()("RunnerError", {
  reason: Schema.Literals([
    "unavailable",
    "protocol",
    "auth",
    "closing",
    "unknown",
    "spawn",
    "invalid",
    "lost",
  ]),
  message: Schema.String,
}) {}

/** How a connection ended: the runner said goodbye because nothing runs any more, or it went away. */
export type Closed = "bye" | "lost"

export type WatchEvent =
  | { readonly type: "command"; readonly command: RunnerProtocol.Command }
  | { readonly type: "output"; readonly offset: number; readonly data: Buffer; readonly size: number }
  | { readonly type: "exit"; readonly exit: RunnerProtocol.Exit }

export interface Connection {
  readonly directory: string
  /** The protocol version both sides agreed on. */
  readonly protocol: number
  /** The runner's release. */
  readonly version: string
  readonly pid: number
  readonly start: (
    command: RunnerProtocol.Start,
  ) => Effect.Effect<{ readonly command: RunnerProtocol.Command; readonly existing: boolean }, RunnerError>
  readonly list: Effect.Effect<readonly RunnerProtocol.Command[], RunnerError>
  readonly signal: (
    id: string,
    signal: string,
    options?: { readonly remove?: boolean },
  ) => Effect.Effect<void, RunnerError>
  readonly deadline: (id: string, deadline: number | null) => Effect.Effect<RunnerProtocol.Command, RunnerError>
  /** The command as it is now, then its output from `offset` (when asked for), then its exit. */
  readonly watch: (
    id: string,
    options: { readonly offset: number; readonly output: boolean; readonly lag?: number },
  ) => Stream.Stream<WatchEvent, RunnerError>
  /** Settles once the connection has ended. */
  readonly closed: Effect.Effect<Closed>
}

type Handler = { readonly frame: (frame: RunnerProtocol.Frame) => boolean; readonly lost: () => void }

const failure = (reason: RunnerError["reason"], message: string) => new RunnerError({ reason, message })

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Connects to the runner of `directory`. Fails with `unavailable` when none runs there. */
export const connect = Effect.fn("RunnerClient.connect")(function* (directory: string) {
  const token = yield* Effect.tryPromise({
    try: () => readFile(RunnerPaths.token(directory), "utf8"),
    catch: () => failure("unavailable", `no runner in ${directory}`),
  })
  const scope = yield* Scope.Scope
  const socket = yield* Effect.callback<net.Socket, RunnerError>((resume) => {
    const socket = net.createConnection({ path: RunnerPaths.socket(directory) })
    socket.once("connect", () => resume(Effect.succeed(socket)))
    socket.once("error", (cause) => resume(Effect.fail(failure("unavailable", describe(cause)))))
    return Effect.sync(() => socket.destroy())
  })
  yield* Scope.addFinalizer(scope, Effect.sync(() => socket.destroy()))
  socket.on("error", () => {})
  socket.setEncoding("utf8")

  const closed = yield* Deferred.make<Closed>()
  const hello = yield* Deferred.make<RunnerProtocol.Hello, RunnerError>()
  const handlers = new Map<number, Handler>()
  let said = false
  let next = 1
  socket.on(
    "data",
    RunnerProtocol.lines(
      (line) => {
        if (!Deferred.isDoneUnsafe(hello)) {
          const greeting = RunnerProtocol.decodeHello(line)
          Deferred.doneUnsafe(
            hello,
            greeting._tag === "Some"
              ? Exit.succeed(greeting.value)
              : Exit.fail(failure("protocol", "the runner did not greet")),
          )
          return
        }
        const frame = RunnerProtocol.decodeFrame(line)
        if (frame._tag === "None") return
        if (frame.value.type === "bye") {
          said = true
          return
        }
        const id = frame.value.id
        if (id === null) return
        const handler = handlers.get(id)
        if (handler && handler.frame(frame.value)) handlers.delete(id)
      },
      () => socket.destroy(),
    ),
  )
  socket.once("close", () => {
    Deferred.doneUnsafe(hello, Exit.fail(failure("lost", "the runner closed the connection")))
    Deferred.doneUnsafe(closed, Exit.succeed(said ? "bye" : "lost"))
    const pending = [...handlers.values()]
    handlers.clear()
    pending.forEach((handler) => handler.lost())
  })

  const write = (value: object) => {
    if (!socket.destroyed) socket.write(JSON.stringify(value) + "\n")
  }

  const request = <A>(build: (id: number) => object, accept: (frame: RunnerProtocol.Frame) => A | undefined) =>
    Effect.callback<A, RunnerError>((resume) => {
      const id = next++
      handlers.set(id, {
        frame: (frame) => {
          if (frame.type === "error") resume(Effect.fail(failure(frame.code, frame.message)))
          else {
            const value = accept(frame)
            resume(
              value === undefined
                ? Effect.fail(failure("protocol", `unexpected ${frame.type} frame`))
                : Effect.succeed(value),
            )
          }
          return true
        },
        lost: () => resume(Effect.fail(failure(said ? "closing" : "lost", "the runner closed the connection"))),
      })
      write(build(id))
      return Effect.sync(() => handlers.delete(id))
    })

  const greeting = yield* Deferred.await(hello)
  const protocol = RunnerProtocol.SUPPORTED.find((version) => greeting.protocols.includes(version))
  if (protocol === undefined)
    return yield* failure(
      "protocol",
      `the runner of ${greeting.version} speaks protocol ${greeting.protocols.join(", ")}; this release speaks ${RunnerProtocol.SUPPORTED.join(", ")}`,
    )
  yield* request(
    (id) => ({ id, op: "hello", protocol, token: token.trim() }),
    (frame) => (frame.type === "ok" ? true : undefined),
  )

  const connection: Connection = {
    directory,
    protocol,
    version: greeting.version,
    pid: greeting.pid,
    start: (command) =>
      request(
        (id) => ({ id, op: "start", command }),
        (frame) => (frame.type === "started" ? { command: frame.command, existing: frame.existing } : undefined),
      ),
    list: request(
      (id) => ({ id, op: "list" }),
      (frame) => (frame.type === "list" ? frame.commands : undefined),
    ),
    signal: (command, signal, options) =>
      request(
        (id) => ({ id, op: "signal", command, signal, ...(options?.remove ? { remove: true } : {}) }),
        (frame) => (frame.type === "ok" ? true : undefined),
      ).pipe(Effect.asVoid),
    deadline: (command, deadline) =>
      request(
        (id) => ({ id, op: "deadline", command, deadline }),
        (frame) => (frame.type === "command" ? frame.command : undefined),
      ),
    watch: (command, options) =>
      Stream.callback<WatchEvent, RunnerError>((queue) =>
        Effect.gen(function* () {
          const id = next++
          handlers.set(id, {
            frame: (frame) => {
              if (frame.type === "error") {
                Queue.failCauseUnsafe(queue, Cause.fail(failure(frame.code, frame.message)))
                return true
              }
              if (frame.type === "command") Queue.offerUnsafe(queue, { type: "command", command: frame.command })
              if (frame.type === "output")
                Queue.offerUnsafe(queue, {
                  type: "output",
                  offset: frame.offset,
                  data: Buffer.from(frame.data, "base64"),
                  size: frame.size,
                })
              if (frame.type !== "exit") return false
              Queue.offerUnsafe(queue, { type: "exit", exit: frame.exit })
              Queue.endUnsafe(queue)
              return true
            },
            lost: () =>
              Queue.failCauseUnsafe(queue, Cause.fail(failure("lost", "the runner closed the connection"))),
          })
          yield* Effect.addFinalizer(() => Effect.sync(() => handlers.delete(id)))
          write({
            id,
            op: "watch",
            command,
            offset: options.offset,
            output: options.output,
            ...(options.lag !== undefined ? { lag: options.lag } : {}),
          })
        }),
      ),
    closed: Deferred.await(closed),
  }
  return connection
})

/**
 * Reads up to `limit` bytes of a command's output from logical `offset` through its runner, as far as it has
 * printed. `offset` in the result is past the one asked for when bytes were dropped.
 */
export const read = Effect.fn("RunnerClient.read")(function* (
  directory: string,
  id: string,
  offset: number,
  limit: number,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* connect(directory)
      const chunks: Buffer[] = []
      const state = { start: offset, size: 0, length: 0, until: Number.POSITIVE_INFINITY }
      // One contiguous run of bytes: a frame past a gap (dropped bytes) ends the read before it.
      yield* connection.watch(id, { offset, output: true }).pipe(
        Stream.runForEachWhile((event) =>
          Effect.sync(() => {
            if (event.type === "exit") return false
            if (event.type === "command") {
              state.size = event.command.size
              state.until = Math.min(event.command.size, offset + limit)
              return offset < state.until
            }
            if (chunks.length > 0 && event.offset !== state.start + state.length) return false
            if (chunks.length === 0) state.start = event.offset
            state.size = event.size
            chunks.push(event.data)
            state.length += event.data.length
            return state.length < limit && event.offset + event.data.length < state.until
          }),
        ),
      )
      const data = Buffer.concat(chunks).subarray(0, Math.max(0, limit))
      return { offset: chunks.length === 0 ? Math.min(offset, state.size) : state.start, data, size: state.size }
    }),
  )
})

/** Connects to the runner of `directory`, starting one with `launch` when none runs there. */
export const connectOrStart = Effect.fn("RunnerClient.connectOrStart")(function* (
  directory: string,
  launch: Effect.Effect<void, RunnerError>,
  timeout: Duration.Input = "10 seconds",
) {
  const attempt = connect(directory)
  return yield* attempt.pipe(
    Effect.catchIf(
      (error) => error.reason === "unavailable" || error.reason === "lost",
      () =>
        launch.pipe(
          Effect.andThen(
            attempt.pipe(
              Effect.retry({
                while: (error) => error.reason === "unavailable" || error.reason === "lost",
                schedule: Schedule.spaced("20 millis"),
              }),
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () => Effect.fail(failure("unavailable", `the runner in ${directory} did not start`)),
              }),
            ),
          ),
        ),
    ),
  )
})

/**
 * Starts the runner `argv` (`openforge runner <directory>`) detached, so it belongs to neither this process nor its
 * group and outlives it. Its stderr goes to the folder's log, which starts over once it passes 1 MiB.
 */
export const launch = (argv: ReadonlyArray<string>, directory: string, env: NodeJS.ProcessEnv = process.env) =>
  Effect.try({
    try: () => {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const log = RunnerPaths.log(directory)
      if ((fs.statSync(log, { throwIfNoEntry: false })?.size ?? 0) > 1024 * 1024) fs.rmSync(log, { force: true })
      const child = spawn("/bin/sh", ["-c", '"$@" </dev/null >/dev/null 2>>"$RUNNER_LOG" &', "sh", ...argv], {
        detached: true,
        stdio: "ignore",
        env: { ...env, RUNNER_LOG: log },
      })
      child.unref()
    },
    catch: (cause) => failure("spawn", describe(cause)),
  })
