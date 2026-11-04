export * as ShellRunner from "./runner.js"

import { readdir, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import { RunnerClient } from "@opencode/runner/client"
import { RunnerOutput } from "@opencode/runner/output"
import { RunnerPaths } from "@opencode/runner/paths"
import { RunnerProtocol } from "@opencode/runner/protocol"
import { RunnerServer } from "@opencode/runner/server"
import { Location } from "@opencode/schema/location"
import { Shell } from "@opencode/schema/shell"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Context, Deferred, Effect, Exit, Layer, Option, Queue, Schema, Scope, Semaphore, Stream } from "effect"
import { App } from "../app.js"
import { Bus } from "../bus.js"

export const DIRECTORY = "shell"
export const STOPPED = "the tool runner stopped unexpectedly"
// Recent exited commands stay observable in memory per Location, including their file-backed output.
const EXITED_LIMIT = 25
const KILL_AFTER = 3_000
// A live view never falls further behind than one page; it skips ahead instead.
const LAG = RunnerOutput.CHUNK

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Shell.NotFoundError", {
  id: Shell.ID,
}) {}

export class RunnerStoppedError extends Schema.TaggedError<RunnerStoppedError>()("Shell.RunnerStoppedError", {
  id: Shell.ID,
  message: Schema.String,
}) {}

// What a later service needs to know a command again; the runner keeps it and writes it into the exit file.
const Meta = Schema.Struct({
  command: Schema.String,
  cwd: Schema.String,
  shell: Schema.String,
  file: Schema.String,
  metadata: Shell.Metadata,
  started: Schema.Number,
  location: Location.Ref,
})
const decodeMeta = Schema.decodeUnknownOption(Meta)

export type Page = { readonly offset: number; readonly data: Buffer; readonly size: number }

/** Controls a running command, wherever it runs. */
export interface Control {
  /** SIGTERM ends the command (SIGKILL follows); `remove` also deletes its files once it has ended. */
  readonly signal: (signal: string, remove: boolean) => Effect.Effect<void>
  readonly deadline: (at: number | null) => Effect.Effect<void>
  /** Output printed so far; undefined when it can no longer be read here, as the exit is then on its way. */
  readonly read: (offset: number, limit: number) => Effect.Effect<Page | undefined>
  readonly watch: (offset: number) => Stream.Stream<RunnerClient.WatchEvent, unknown>
}

export type StartInput = {
  readonly info: Shell.Info
  readonly location: Location.Ref
  /** Final: already wrapped, for example in a sandbox. */
  readonly argv: readonly [string, ...string[]]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  /** Milliseconds since the epoch. */
  readonly deadline: number | undefined
}

export interface Interface {
  /** Starts a command in this release's runner, starting the runner first when none runs. */
  readonly start: (input: StartInput) => Effect.Effect<Shell.Info, AppProcess.AppProcessError>
  /** Registers a command run by someone else (a workspace's process); the returned effect reports its end. */
  readonly attach: (input: {
    readonly info: Shell.Info
    readonly location: Location.Ref
    readonly control: Control
  }) => Effect.Effect<(exit: RunnerProtocol.Exit) => Effect.Effect<void>>
  /** Also commands of an earlier service: adopted from a runner, or from their exit file once it has gone. */
  readonly get: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  readonly wait: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError | RunnerStoppedError>
  readonly output: (id: Shell.ID, input?: Shell.OutputInput) => Effect.Effect<Shell.Output, NotFoundError>
  readonly watch: (id: Shell.ID, input?: Shell.WatchInput) => Stream.Stream<Shell.WatchEvent, NotFoundError>
  readonly timeout: (id: Shell.ID, duration: number) => Effect.Effect<Shell.Info, NotFoundError>
  readonly remove: (id: Shell.ID) => Effect.Effect<void, NotFoundError>
  /** Running commands of one Location. */
  readonly list: (location: Location.Ref) => Effect.Effect<Shell.Info[]>
  /** Newlines a finished command printed. */
  readonly lines: (id: Shell.ID) => Effect.Effect<number, NotFoundError>
  /** Locations with a running command. */
  readonly running: Effect.Effect<ReadonlyArray<Location.Ref>>
  /**
   * The service is shutting down: from now on a remove leaves its command running in the runner and its files in
   * place, so the next service picks it up. Other interruptions (a cancelled job, a user stopping a turn) still end
   * their commands.
   */
  readonly detach: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShellRunner") {}

export type Options = {
  /**
   * Starts the runner of a folder detached, for example `openforge runner <folder>`. Without it the runner runs
   * inside this process, and its commands end with it.
   */
  readonly launch?: (directory: string) => Effect.Effect<void, RunnerClient.RunnerError>
}

/** Starts runners as `command <folder>`, detached from this process. */
export const detached =
  (command: ReadonlyArray<string>) =>
  (directory: string): Effect.Effect<void, RunnerClient.RunnerError> =>
    RunnerClient.launch([...command, directory], directory)

type Entry = {
  info: Shell.Info
  readonly location: Location.Ref
  readonly key: string
  readonly done: Deferred.Deferred<Shell.Info, NotFoundError | RunnerStoppedError>
  readonly pgid: number | undefined
  control: Control | undefined
  exit: RunnerProtocol.Exit | undefined
  removed: boolean
}

type Remote = {
  readonly directory: string
  readonly connection: RunnerClient.Connection
  readonly scope: Scope.Closeable
  readonly entries: Set<Shell.ID>
  closed: boolean
}

const key = (ref: Location.Ref) => `${ref.directory}\0${ref.workspaceID ?? ""}`

const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const bus = yield* Bus.Service
      const app = yield* App.Metadata
      const scope = yield* Scope.Scope
      // A runner hosted in this process gets a folder of its own, so no other service starts commands in it.
      const current = options.launch
        ? RunnerPaths.directory(global.state, app.version)
        : path.join(global.tmp, "runner", `${app.version}-${process.pid}`)
      const shells = path.join(global.data, DIRECTORY)
      const entries = new Map<Shell.ID, Entry>()
      const exited = new Map<string, Shell.ID[]>()
      const remotes = new Map<string, Remote>()
      const starting = Semaphore.makeUnsafe(1)
      const adopted = yield* Deferred.make<void>()
      const state = { detached: false, hosted: undefined as RunnerServer.Runner | undefined }

      const hosted = Effect.tryPromise({
        try: () =>
          RunnerServer.serve({ directory: current, version: app.version }).then(
            (runner) => void (state.hosted = runner),
            (cause: unknown) => {
              // Another process's runner serves the folder; connecting to it is all that is needed.
              if (!(cause instanceof RunnerServer.LockedError)) throw cause
            },
          ),
        catch: (cause) => new RunnerClient.RunnerError({ reason: "spawn", message: String(cause) }),
      })
      const launch = options.launch?.(current) ?? hosted
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          // A runner hosted here ends with this service, as its commands would have without one.
          if (!state.hosted) return
          await state.hosted.shutdown()
          await rm(current, { recursive: true, force: true })
        }),
      )

      const publishExited = (entry: Entry) =>
        bus.publish(
          Shell.Event.Exited,
          {
            id: entry.info.id,
            ...(entry.info.exit !== undefined ? { exit: entry.info.exit } : {}),
            status: entry.info.status,
          },
          { location: entry.location },
        )

      const forget = Effect.fnUntraced(function* (entry: Entry) {
        entries.delete(entry.info.id)
        const order = exited.get(entry.key)
        const index = order?.indexOf(entry.info.id) ?? -1
        if (order && index !== -1) order.splice(index, 1)
        entry.removed = true
        yield* Deferred.fail(entry.done, new NotFoundError({ id: entry.info.id }))
      })

      const discard = (file: string) =>
        Effect.promise(() =>
          Promise.all([rm(file, { force: true }), rm(RunnerPaths.exit(file), { force: true })]).then(() => undefined),
        )

      const evict = Effect.fnUntraced(function* (entry: Entry) {
        yield* forget(entry)
        yield* discard(entry.info.file)
        yield* bus.publish(Shell.Event.Deleted, { id: entry.info.id }, { location: entry.location })
      })

      // `announce` is false for a command that ended before this service knew it. Uninterruptible: the watch that
      // reports an exit ends with its connection, which closes as soon as the runner has nothing left to run.
      const finish = (entry: Entry, exit: RunnerProtocol.Exit, announce = true) =>
        settle(entry, exit, announce).pipe(Effect.uninterruptible)

      const settle = Effect.fnUntraced(function* (entry: Entry, exit: RunnerProtocol.Exit, announce: boolean) {
        if (entry.exit) return
        entry.exit = exit
        entry.control = undefined
        if (entry.removed) return
        entry.info = terminal(entry.info, exit)
        // Evict before waking waiters, so one that looks at older commands next sees the retained set.
        const order = exited.get(entry.key) ?? []
        exited.set(entry.key, order)
        order.push(entry.info.id)
        while (order.length > EXITED_LIMIT) {
          const oldest = entries.get(order[0])
          if (!oldest) order.shift()
          else yield* evict(oldest)
        }
        if (exit.status === "failed")
          yield* Deferred.fail(
            entry.done,
            new RunnerStoppedError({ id: entry.info.id, message: exit.error ?? STOPPED }),
          )
        else yield* Deferred.succeed(entry.done, entry.info)
        if (announce) yield* publishExited(entry)
      })

      const register = (input: {
        info: Shell.Info
        location: Location.Ref
        pgid?: number
        control?: Control
        exit?: RunnerProtocol.Exit
      }) =>
        Effect.gen(function* () {
          const entry: Entry = {
            info: input.info,
            location: input.location,
            key: key(input.location),
            done: yield* Deferred.make<Shell.Info, NotFoundError | RunnerStoppedError>(),
            pgid: input.pgid,
            control: input.control,
            exit: undefined,
            removed: false,
          }
          entries.set(input.info.id, entry)
          if (input.exit) yield* finish(entry, input.exit, false)
          return entry
        })

      // A runner went away while commands of it ran: those that finished meanwhile are read from their exit files;
      // the rest lost their runner, so their groups are stopped here and they are reported failed.
      const orphaned = Effect.fnUntraced(function* (entry: Entry) {
        const exit = yield* readExit(entry.info.file)
        if (exit) return yield* finish(entry, exit)
        if (entry.pgid !== undefined) stop(entry.pgid)
        const now = Date.now()
        const printed = yield* Effect.promise(() => count(entry.info.file))
        const failed: RunnerProtocol.Exit = {
          id: entry.info.id,
          status: "failed",
          error: STOPPED,
          pid: entry.info.pid ?? 0,
          started: entry.info.time.started,
          ended: now,
          size: printed.size,
          lines: printed.lines,
          meta: meta(entry),
        }
        yield* Effect.promise(() => RunnerOutput.writeAtomic(RunnerPaths.exit(entry.info.file), JSON.stringify(failed)))
        yield* finish(entry, failed)
      })

      const closed = Effect.fnUntraced(function* (remote: Remote, reason: RunnerClient.Closed): Effect.fn.Return<void> {
        remote.closed = true
        if (remotes.get(remote.directory) === remote) remotes.delete(remote.directory)
        yield* Scope.close(remote.scope, Exit.void)
        if (state.detached) return
        const running = [...remote.entries].flatMap((id) => {
          const entry = entries.get(id)
          return entry && !entry.exit && !entry.removed ? [entry] : []
        })
        if (running.length === 0) return
        // A dropped connection to a runner that still lives is picked up again.
        if (reason === "lost" && (yield* connectTo(remote.directory).pipe(Effect.option))._tag === "Some") return
        yield* Effect.forEach(running, orphaned, { discard: true })
      })

      const control = (remote: Remote, id: Shell.ID, pgid: number, file: string): Control => ({
        signal: (signal, remove) =>
          remote.connection.signal(id, signal, { remove }).pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                // The runner is gone; the group is stopped directly.
                if (signal === "SIGTERM") stop(pgid)
                if (remove) yield* discard(file)
              }),
            ),
          ),
        deadline: (at) => remote.connection.deadline(id, at).pipe(Effect.ignore),
        read: (offset, limit) =>
          RunnerClient.read(remote.directory, id, offset, limit).pipe(
            Effect.map((page): Page | undefined => page),
            Effect.orElseSucceed(() => undefined),
          ),
        watch: (offset) =>
          Stream.unwrap(
            RunnerClient.connect(remote.directory).pipe(
              Effect.map((connection) => connection.watch(id, { offset, output: true, lag: LAG })),
            ),
          ),
      })

      const track = Effect.fnUntraced(function* (remote: Remote, entry: Entry) {
        remote.entries.add(entry.info.id)
        yield* remote.connection.watch(entry.info.id, { offset: 0, output: false }).pipe(
          Stream.runForEach((event) => (event.type === "exit" ? finish(entry, event.exit) : Effect.void)),
          Effect.ignore,
          Effect.forkIn(remote.scope, { startImmediately: true }),
        )
      })

      // Knows a runner's commands: adopts those this service does not know yet and follows the running ones.
      const adopt = Effect.fnUntraced(function* (remote: Remote) {
        const commands = yield* remote.connection.list.pipe(Effect.orElseSucceed(() => []))
        yield* Effect.forEach(
          commands,
          Effect.fnUntraced(function* (command) {
            if (command.removed) return
            const known = entries.get(Shell.ID.make(command.id))
            if (known) {
              if (known.exit || known.removed) return
              known.control = control(remote, known.info.id, command.pgid, known.info.file)
              if (command.exit) return yield* finish(known, command.exit)
              return yield* track(remote, known)
            }
            const decoded = decodeMeta(command.meta)
            if (decoded._tag === "None") return
            const info = describe(command.id, decoded.value, command.pid)
            const entry = yield* register({
              info,
              location: decoded.value.location,
              pgid: command.pgid,
              control: command.exit ? undefined : control(remote, info.id, command.pgid, info.file),
              exit: command.exit,
            })
            if (!command.exit) yield* track(remote, entry)
          }),
          { discard: true },
        )
      })

      const connectTo = Effect.fnUntraced(function* (
        directory: string,
        start?: Effect.Effect<void, RunnerClient.RunnerError>,
      ): Effect.fn.Return<Remote, RunnerClient.RunnerError> {
        const remoteScope = yield* Scope.fork(scope)
        const connection = yield* (
          start ? RunnerClient.connectOrStart(directory, start) : RunnerClient.connect(directory)
        ).pipe(
          Scope.provide(remoteScope),
          Effect.onError(() => Scope.close(remoteScope, Exit.void)),
        )
        const remote: Remote = { directory, connection, scope: remoteScope, entries: new Set(), closed: false }
        remotes.set(directory, remote)
        yield* connection.closed.pipe(
          Effect.flatMap((reason) => closed(remote, reason)),
          Effect.forkIn(scope, { startImmediately: true }),
        )
        yield* adopt(remote)
        return remote
      })

      const runner = starting.withPermit(
        Effect.suspend(() => {
          const existing = remotes.get(current)
          return existing && !existing.closed ? Effect.succeed(existing) : connectTo(current, launch)
        }),
      )

      // Commands still running in a runner of this or an earlier release, from before this service started.
      yield* Effect.promise(() => readdir(RunnerPaths.root(global.state)).catch(() => [] as string[])).pipe(
        Effect.flatMap((names) =>
          Effect.forEach(
            names,
            (name) => connectTo(path.join(RunnerPaths.root(global.state), name)).pipe(Effect.ignore),
            { concurrency: 8, discard: true },
          ),
        ),
        Effect.ensuring(Deferred.succeed(adopted, undefined)),
        Effect.forkIn(scope, { startImmediately: true }),
      )

      // Finished commands of an earlier service, known only from their exit file.
      const fromDisk = Effect.fnUntraced(function* (id: Shell.ID) {
        const projects = yield* Effect.promise(() => readdir(shells).catch(() => [] as string[]))
        for (const project of projects) {
          const exit = yield* readExit(path.join(shells, project, `${id}.out`))
          if (!exit) continue
          const decoded = decodeMeta(exit.meta)
          if (decoded._tag === "None") return undefined
          return yield* register({
            info: describe(id, decoded.value, exit.pid),
            location: decoded.value.location,
            exit,
          })
        }
        return undefined
      })

      const require = Effect.fnUntraced(function* (id: Shell.ID) {
        const known = entries.get(id)
        if (known) return known
        yield* Deferred.await(adopted)
        const entry = entries.get(id) ?? (yield* fromDisk(id))
        if (!entry) return yield* new NotFoundError({ id })
        return entry
      })

      const start = Effect.fn("ShellRunner.start")(function* (input: StartInput) {
        const failure = (cause: unknown) => new AppProcess.AppProcessError({ command: input.info.command, cause })
        const request: RunnerProtocol.Start = {
          id: input.info.id,
          argv: [...input.argv],
          cwd: input.cwd,
          env: { ...input.env },
          deadline: input.deadline ?? null,
          output: input.info.file,
          meta: {
            command: input.info.command,
            cwd: input.info.cwd,
            shell: input.info.shell,
            file: input.info.file,
            metadata: input.info.metadata,
            started: input.info.time.started,
            location: input.location,
          },
        }
        const attempt = runner.pipe(
          Effect.flatMap((remote) =>
            remote.connection.start(request).pipe(
              Effect.map((started) => ({ remote, started })),
              Effect.tapError((error) =>
                Effect.sync(() => {
                  if (error.reason !== "closing" && error.reason !== "lost") return
                  remote.closed = true
                  if (remotes.get(remote.directory) === remote) remotes.delete(remote.directory)
                }),
              ),
            ),
          ),
        )
        // A runner that is exiting because its last command ended refuses new ones; the next one takes them.
        const { remote, started } = yield* attempt.pipe(
          Effect.catchIf(
            (error) => error.reason === "closing" || error.reason === "lost",
            () => attempt,
          ),
          Effect.mapError(failure),
        )
        const entry = yield* register({
          info: { ...input.info, pid: started.command.pid },
          location: input.location,
          pgid: started.command.pgid,
          control: control(remote, input.info.id, started.command.pgid, input.info.file),
        })
        yield* track(remote, entry)
        yield* bus.publish(Shell.Event.Created, { info: entry.info }, { location: input.location })
        return entry.info
      })

      const attach: Interface["attach"] = Effect.fnUntraced(function* (input) {
        const entry = yield* register({ info: input.info, location: input.location, control: input.control })
        yield* bus.publish(Shell.Event.Created, { info: entry.info }, { location: input.location })
        return (exit) => finish(entry, exit)
      })

      const output = Effect.fnUntraced(function* (id: Shell.ID, input?: Shell.OutputInput) {
        const entry = yield* require(id)
        const cursor = input?.cursor ?? 0
        const limit = input?.limit ?? 65_536
        if (entry.control) {
          const page = yield* entry.control.read(cursor, limit)
          if (page)
            return {
              output: page.data.toString("utf8"),
              cursor: page.offset + page.data.length,
              size: page.size,
              truncated: page.offset > cursor,
            }
          yield* Deferred.await(entry.done).pipe(Effect.ignore)
        }
        const exit = entry.exit
        if (!exit || entry.removed) return yield* new NotFoundError({ id })
        const read = yield* Effect.promise(() =>
          RunnerOutput.read(entry.info.file, exit, cursor, limit).catch(() => ({
            data: Buffer.alloc(0),
            cursor: Math.min(cursor, exit.size),
            skipped: false,
          })),
        )
        return { output: read.data.toString("utf8"), cursor: read.cursor, size: exit.size, truncated: read.skipped }
      })

      const watch = (id: Shell.ID, input?: Shell.WatchInput) =>
        Stream.callback<Shell.WatchEvent, NotFoundError>(
          (queue) =>
            Effect.gen(function* () {
              const entry = yield* require(id)
              const decoder = new TextDecoder()
              let cursor = input?.cursor ?? 0
              const emit = (data: Buffer, offset: number, size: number) => {
                const truncated = offset > cursor
                cursor = offset + data.length
                return Queue.offer(queue, {
                  type: "output" as const,
                  output: decoder.decode(data, { stream: true }),
                  cursor,
                  size,
                  truncated,
                })
              }
              const live = entry.control
              if (live)
                yield* live.watch(cursor).pipe(
                  Stream.runForEach((event) =>
                    event.type === "output" ? emit(event.data, event.offset, event.size) : Effect.void,
                  ),
                  Effect.ignore,
                )
              const info = yield* Deferred.await(entry.done).pipe(Effect.orElseSucceed(() => entry.info))
              const exit = entry.exit
              // What the live view skipped at the end, or all of it for a command that had finished.
              while (exit && cursor < exit.size) {
                const read = yield* Effect.promise(() =>
                  RunnerOutput.read(entry.info.file, exit, cursor, RunnerOutput.CHUNK).catch(() => undefined),
                )
                if (!read || read.cursor <= cursor) break
                const truncated = read.skipped
                cursor = read.cursor
                yield* Queue.offer(queue, {
                  type: "output",
                  output: decoder.decode(read.data, { stream: true }),
                  cursor,
                  size: exit.size,
                  truncated,
                })
              }
              yield* Queue.offer(queue, { type: "exited", info })
              yield* Queue.end(queue)
            }),
          { bufferSize: 16, strategy: "suspend" },
        )

      const timeout = Effect.fn("ShellRunner.timeout")(function* (id: Shell.ID, duration: number) {
        const entry = yield* require(id)
        if (entry.exit || !entry.control) return entry.info
        // Wall-clock time: the runner holds the deadline as a point in time.
        yield* entry.control.deadline(duration === 0 ? null : Date.now() + duration)
        return entry.info
      })

      const remove = Effect.fn("ShellRunner.remove")(function* (id: Shell.ID) {
        const entry = yield* require(id)
        if (state.detached) return
        const running = entry.control
        yield* forget(entry)
        if (running && !entry.exit) {
          yield* running.signal("SIGTERM", true)
          // Every shell reports exactly one exit; removing a running one ends it as killed.
          yield* bus.publish(Shell.Event.Exited, { id, status: "killed" }, { location: entry.location })
        } else yield* discard(entry.info.file)
        yield* bus.publish(Shell.Event.Deleted, { id }, { location: entry.location })
      })

      return Service.of({
        start,
        attach,
        get: Effect.fn("ShellRunner.get")(function* (id) {
          return (yield* require(id)).info
        }),
        wait: Effect.fn("ShellRunner.wait")(function* (id) {
          return yield* Deferred.await((yield* require(id)).done)
        }),
        output,
        watch,
        timeout,
        remove,
        list: (location) =>
          Effect.sync(() =>
            [...entries.values()]
              .filter((entry) => entry.key === key(location) && !entry.exit && !entry.removed)
              .map((entry) => entry.info),
          ),
        lines: Effect.fnUntraced(function* (id) {
          return (yield* require(id)).exit?.lines ?? 0
        }),
        running: Effect.sync(() =>
          [...entries.values()].flatMap((entry) => (!entry.exit && !entry.removed ? [entry.location] : [])),
        ),
        detach: Effect.sync(() => {
          state.detached = true
        }),
      })
    }),
  )

export const configured = (options: Options = {}) =>
  makeGlobalNode({ service: Service, layer: layer(options), deps: [Global.node, Bus.node, App.node] })

export const node = configured()

function describe(id: string, meta: typeof Meta.Type, pid?: number): Shell.Info {
  return {
    id: Shell.ID.make(id),
    status: "running",
    command: meta.command,
    cwd: meta.cwd,
    shell: meta.shell,
    file: meta.file,
    ...(pid !== undefined ? { pid } : {}),
    metadata: meta.metadata,
    time: { started: meta.started },
  }
}

function meta(entry: Entry) {
  return {
    command: entry.info.command,
    cwd: entry.info.cwd,
    shell: entry.info.shell,
    file: entry.info.file,
    metadata: entry.info.metadata,
    started: entry.info.time.started,
    location: entry.location,
  }
}

// How a command's end reads as Shell.Info. Only a command that exited by itself reports its code or signal.
function terminal(info: Shell.Info, exit: RunnerProtocol.Exit): Shell.Info {
  const status = exit.status === "failed" ? "killed" : exit.status
  return {
    ...info,
    status,
    ...(status === "exited" && exit.code !== undefined ? { exit: exit.code } : {}),
    ...(status === "exited" && exit.signal !== undefined ? { signal: exit.signal } : {}),
    time: { ...info.time, completed: exit.ended },
  }
}

const readExit = (output: string) =>
  Effect.promise(() =>
    readFile(RunnerPaths.exit(output), "utf8").then(
      (text) => Option.getOrUndefined(RunnerProtocol.decodeExit(text)),
      () => undefined,
    ),
  )

async function count(file: string) {
  const info = await stat(file).catch(() => undefined)
  if (!info) return { size: 0, lines: 0 }
  const data = await readFile(file)
  let lines = 0
  for (let index = data.indexOf(10); index !== -1; index = data.indexOf(10, index + 1)) lines++
  return { size: info.size, lines }
}

// SIGTERM to the group now and SIGKILL a moment later, as the runner itself would.
function stop(pgid: number) {
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pgid, signal)
    } catch {}
  }
  kill("SIGTERM")
  setTimeout(() => kill("SIGKILL"), KILL_AFTER).unref()
}
