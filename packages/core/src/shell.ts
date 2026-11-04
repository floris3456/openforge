export * as Shell from "./shell.js"

import { mkdir, rm } from "fs/promises"
import path from "path"
import { Context, Deferred, Duration, Effect, Fiber, Layer, Queue, Schedule, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import type { RunnerClient } from "@opencode/runner/client"
import { RunnerOutput } from "@opencode/runner/output"
import { RunnerPaths } from "@opencode/runner/paths"
import type { RunnerProtocol } from "@opencode/runner/protocol"
import { Shell } from "@opencode/schema/shell"
import { AppProcess } from "@opencode/util/process"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import { Environment } from "./environment/index.js"
import { FileRetention } from "./file-retention.js"
import { Location } from "./location.js"
import { ShellSelect } from "./shell/select.js"
import { PluginHooks } from "./plugin/hooks.js"
import { SessionEnvironment } from "./session/environment.js"
import { SessionSchema } from "./session/schema.js"
import { Config } from "./config.js"
import { ToolOutput } from "./tool-output.js"
import { ShellResult } from "./shell/result.js"
import { ShellRunner } from "./shell/runner.js"
import { ShellWrap } from "./shell/wrap.js"

export { NotFoundError, RunnerStoppedError } from "./shell/runner.js"
export const ID = Shell.ID
export type ID = Shell.ID

export const RETENTION = Duration.days(7)
export const DIRECTORY = ShellRunner.DIRECTORY

type CreateInput = Shell.CreateInput & {
  shell?: string
}

/**
 * Location-owned non-interactive shell commands, run by the tool runner (see `ShellRunner`), so they outlive this
 * service: a restart, a switch to a newer release or a crash of the service leaves them running, and the next service
 * knows their IDs again. Each command's combined stdout/stderr goes to a file of at most 8 MiB; `output` pages through
 * it by cursor and `watch` follows it live. No session, message, or permission state lives here; callers (e.g.
 * `ShellTool`) own that association and store the shell ID.
 */
export interface Interface {
  readonly create: <E = never, R = never>(
    input: CreateInput,
    before?: (input: ShellCreateBefore) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<Shell.Info, E | AppProcess.AppProcessError, R>
  // Currently running commands only; exited shells are retained for get/output but excluded here.
  readonly list: () => Effect.Effect<Shell.Info[]>
  readonly get: (id: Shell.ID) => Effect.Effect<Shell.Info, ShellRunner.NotFoundError>
  // Resolves once the command reaches a terminal status, returning its final Info. Fails with NotFoundError if the
  // command is unknown or is removed before it terminates, and with RunnerStoppedError if its runner died under it.
  readonly wait: (id: Shell.ID) => Effect.Effect<Shell.Info, ShellRunner.NotFoundError | ShellRunner.RunnerStoppedError>
  // A known shell's terminal state and bounded tail. Missing capture remains distinct from its exit status.
  readonly result: (started: Shell.Info) => Effect.Effect<ShellResult.Result, ShellRunner.RunnerStoppedError>
  // Replaces the running command's timeout from now; zero clears it. Ignored once the command has ended.
  readonly timeout: (id: Shell.ID, duration: number) => Effect.Effect<Shell.Info, ShellRunner.NotFoundError>
  readonly output: (id: Shell.ID, input?: Shell.OutputInput) => Effect.Effect<Shell.Output, ShellRunner.NotFoundError>
  // Output as it arrives from `cursor` on, then the terminal Info.
  readonly watch: (id: Shell.ID, input?: Shell.WatchInput) => Stream.Stream<Shell.WatchEvent, ShellRunner.NotFoundError>
  readonly remove: (id: Shell.ID) => Effect.Effect<void, ShellRunner.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Shell") {}

export const cleanup = Effect.fn("Shell.cleanup")(function* () {
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const directory = path.join(global.data, DIRECTORY)
  const projects = yield* fs.readDirectoryEntries(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => entry.type === "directory")),
    Effect.orElseSucceed(() => []),
  )
  const files = yield* Effect.forEach(
    projects,
    (project) =>
      fs.readDirectoryEntries(path.join(directory, project.name)).pipe(
        Effect.map((entries) =>
          entries.flatMap((entry) =>
            entry.type === "file" && /^sh_[0-9a-f]{12}.*\.(out|exit|tmp)$/.test(entry.name)
              ? [path.join(directory, project.name, entry.name)]
              : [],
          ),
        ),
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: 8 },
  )
  yield* FileRetention.cleanup(fs, files.flat(), RETENTION)
})

const cleanupLayer = Layer.effectDiscard(
  cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped),
)

const cleanupNode = makeGlobalNode({
  name: "shell-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})

const layer = () =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const runner = yield* ShellRunner.Service
      const wrap = yield* ShellWrap.Service
      const location = yield* Location.Service
      const global = yield* Global.Service
      const shell = yield* ShellSelect.Service
      const environment = yield* Environment.Service
      const hooks = yield* PluginHooks.Service
      const environments = yield* SessionEnvironment.Service
      const config = yield* Config.Service
      const runFork = Effect.runForkWith(yield* Effect.context())
      const ref = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })

      const outputDir = path.join(global.data, DIRECTORY, location.project.id)
      yield* Effect.promise(() => mkdir(outputDir, { recursive: true }))

      const result = Effect.fn("Shell.result")(function* (started: Shell.Info) {
        const info = yield* runner.wait(started.id).pipe(
          Effect.catchTag("Shell.NotFoundError", () =>
            Effect.succeed({
              ...started,
              status: "killed" as const,
              time: { ...started.time, completed: Date.now() },
            }),
          ),
        )
        const capture = yield* Effect.gen(function* () {
          const limits = Config.latest(yield* config.entries(), "tool_output")
          const maxLines = limits?.max_lines ?? ToolOutput.MAX_LINES
          const maxBytes = limits?.max_bytes ?? ToolOutput.MAX_BYTES
          const latest = yield* runner.output(info.id, { cursor: Number.MAX_SAFE_INTEGER })
          const page = yield* runner.output(info.id, { cursor: Math.max(0, latest.size - maxBytes), limit: maxBytes })
          const lines = page.output.split("\n")
          if (page.output.endsWith("\n")) lines.pop()
          const truncated = latest.size > maxBytes || lines.length > maxLines
          const text = lines.length > maxLines ? lines.slice(-maxLines).join("\n") : page.output
          // Counted by the runner while the command printed, so a notice never rescans the output file.
          const total = (yield* runner.lines(info.id)) + (page.output.endsWith("\n") ? 0 : 1)
          const shown = Math.min(lines.length, maxLines)
          const notice = truncated
            ? `\n\n[showing lines ${total - shown + 1}-${total} of ${total}; full output saved to ${info.file}]`
            : ""
          return { output: `${text || "(no output)"}${notice}`, truncated }
        }).pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(undefined)))
        return { info, capture }
      })

      // A workspace-backed Location runs its commands in the workspace's own environment, and Windows has no tool
      // runner: these commands run from this service, and do not outlive it.
      const inProcess = Effect.fnUntraced(function* (info: Shell.Info, command: ShellWrap.Command, deadline?: number) {
        const ready = Deferred.makeUnsafe<Shell.Info, AppProcess.AppProcessError>()
        runFork(
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* environment.spawner
                .spawn(
                  ChildProcess.make(command.argv[0], command.argv.slice(1), {
                    cwd: command.cwd,
                    env: command.env,
                    stdin: "ignore",
                    detached: process.platform !== "win32",
                    forceKillAfter: Duration.seconds(3),
                  }),
                )
                .pipe(Effect.mapError((cause) => new AppProcess.AppProcessError({ command: info.command, cause })))
              const writer = new RunnerOutput.Writer(info.file)
              const state: {
                reason?: "timeout" | "killed"
                remove: boolean
                timer?: Fiber.Fiber<void>
                ended: boolean
                // Bumped by every append and by the end, so a watch never misses one between its read and its wait.
                version: number
              } = { remove: false, ended: false, version: 0 }
              const wakes = new Set<() => void>()
              const wake = () => {
                state.version++
                // Taken out first: a resumed watch may wait again at once, and must not be resumed again here.
                const waiting = [...wakes]
                wakes.clear()
                waiting.forEach((resume) => resume())
              }
              const changed = (seen: number) =>
                Effect.callback<void>((resume) => {
                  if (state.version !== seen) return resume(Effect.void)
                  const done = () => resume(Effect.void)
                  wakes.add(done)
                  return Effect.sync(() => wakes.delete(done))
                })
              // Live output until the command ends; ShellRunner reads what is left from the finished file.
              const follow = (offset: number) =>
                Stream.callback<RunnerClient.WatchEvent>((queue) =>
                  Effect.gen(function* () {
                    let cursor = offset
                    while (!state.ended) {
                      const seen = state.version
                      const chunk = writer.read(cursor)
                      if (chunk && chunk.data.length > 0) {
                        cursor = chunk.offset + chunk.data.length
                        yield* Queue.offer(queue, {
                          type: "output",
                          offset: chunk.offset,
                          data: chunk.data,
                          size: writer.size,
                        })
                        continue
                      }
                      yield* changed(seen)
                    }
                    yield* Queue.end(queue)
                  }),
                )
              const kill = () => runFork(handle.kill({ forceKillAfter: Duration.seconds(3) }).pipe(Effect.ignore))
              const arm = (at: number | null) =>
                Effect.gen(function* () {
                  if (state.timer) yield* Fiber.interrupt(state.timer)
                  state.timer = undefined
                  if (at === null) return
                  state.timer = runFork(
                    Effect.sleep(Duration.millis(Math.max(0, at - Date.now()))).pipe(
                      Effect.andThen(
                        Effect.sync(() => {
                          state.reason ??= "timeout"
                          kill()
                        }),
                      ),
                    ),
                  )
                })
              const started = { ...info, pid: handle.pid }
              const finish = yield* runner.attach({
                info: started,
                location: ref,
                control: {
                  signal: (_signal, remove) =>
                    Effect.sync(() => {
                      state.reason ??= "killed"
                      state.remove ||= remove
                      kill()
                    }),
                  deadline: arm,
                  read: (offset, limit) =>
                    Effect.sync(() => {
                      const chunk = writer.read(offset, limit)
                      return chunk
                        ? { offset: chunk.offset, data: chunk.data, size: writer.size }
                        : { offset: Math.min(offset, writer.size), data: Buffer.alloc(0), size: writer.size }
                    }),
                  watch: follow,
                },
              })
              yield* arm(deadline ?? null)
              yield* Deferred.succeed(ready, started)
              const [status] = yield* Effect.all(
                [
                  handle.exitCode.pipe(
                    Effect.map((code): { code?: number; signal?: string } => ({ code })),
                    Effect.catch((error) =>
                      Effect.succeed<{ code?: number; signal?: string }>({
                        signal:
                          error.cause instanceof CrossSpawnSpawner.KilledBySignal ? error.cause.signal : undefined,
                      }),
                    ),
                  ),
                  handle.all.pipe(
                    Stream.runForEach((chunk: Uint8Array) =>
                      Effect.sync(() => {
                        writer.append(chunk)
                        wake()
                      }),
                    ),
                    Effect.ignore,
                  ),
                ],
                { concurrency: 2 },
              )
              if (state.timer) yield* Fiber.interrupt(state.timer)
              state.ended = true
              wake()
              const layout = writer.finish()
              writer.close()
              const exit: RunnerProtocol.Exit = {
                id: info.id,
                status: state.reason ?? "exited",
                ...(status.code !== undefined ? { code: status.code } : {}),
                ...(status.signal !== undefined ? { signal: status.signal } : {}),
                pid: started.pid,
                started: info.time.started,
                ended: Date.now(),
                size: writer.size,
                lines: writer.lines,
                ...(layout ? { layout } : {}),
                meta: {
                  command: info.command,
                  cwd: info.cwd,
                  shell: info.shell,
                  file: info.file,
                  metadata: info.metadata,
                  started: info.time.started,
                  location: ref,
                },
              }
              yield* Effect.promise(() =>
                state.remove
                  ? Promise.all([
                      rm(info.file, { force: true }),
                      rm(RunnerPaths.exit(info.file), { force: true }),
                    ]).then(() => undefined)
                  : RunnerOutput.writeAtomic(RunnerPaths.exit(info.file), JSON.stringify(exit)),
              )
              yield* finish(exit)
            }),
          ).pipe(Effect.catchTag("AppProcessError", (error) => Deferred.fail(ready, error))),
        )
        return yield* Deferred.await(ready)
      })

      const create = Effect.fn("Shell.create")(function* <E = never, R = never>(
        input: CreateInput,
        before?: (input: ShellCreateBefore) => Effect.Effect<void, E, R>,
      ) {
        const sessionID = input.metadata?.sessionID
        const baseEnv =
          location.workspaceID !== undefined
            ? undefined
            : ((Schema.is(SessionSchema.ID)(sessionID) ? yield* environments.get(sessionID) : undefined) ?? process.env)
        const invocation: ShellCreateBefore = {
          command: input.command,
          cwd: input.cwd ?? location.directory,
          timeout: input.timeout ?? 0,
          shell: input.shell ?? (yield* shell.resolve({ priority: "config" })),
          env: {
            ...baseEnv,
            TERM: "xterm-256color",
            OPENCODE_TERMINAL: "1",
          },
        }
        yield* hooks.trigger("shell", "create.before", invocation)
        if (before) yield* before(invocation)

        const id = Shell.ID.ascending()
        // Wall-clock time: the runner holds the deadline as a point in time, outside this service's clock.
        const started = Date.now()
        const info: Shell.Info = {
          id,
          status: "running",
          command: invocation.command,
          cwd: invocation.cwd,
          shell: invocation.shell,
          file: path.join(outputDir, `${id}.out`),
          metadata: input.metadata ?? {},
          time: { started },
        }
        const command = yield* wrap.wrap(
          {
            argv: [invocation.shell, ...ShellSelect.args(invocation.shell, invocation.command)],
            cwd: invocation.cwd,
            env: Object.fromEntries(
              Object.entries(invocation.env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
            ),
          },
          { metadata: info.metadata },
        )
        const deadline = invocation.timeout > 0 ? started + invocation.timeout : undefined
        if (location.workspaceID !== undefined || process.platform === "win32")
          return yield* inProcess(info, command, deadline)
        return yield* runner.start({
          info,
          location: ref,
          argv: command.argv,
          cwd: command.cwd,
          env: command.env,
          deadline,
        })
      })

      return Service.of({
        create,
        list: () => runner.list(ref),
        get: runner.get,
        wait: runner.wait,
        result,
        timeout: runner.timeout,
        output: runner.output,
        watch: runner.watch,
        remove: runner.remove,
      })
    }),
  )

export const node = makeLocationNode({
  service: Service,
  layer: layer(),
  deps: [
    ShellRunner.node,
    ShellWrap.node,
    Location.node,
    Global.node,
    ShellSelect.node,
    Environment.node,
    PluginHooks.node,
    SessionEnvironment.node,
    Config.node,
    cleanupNode,
  ],
})
