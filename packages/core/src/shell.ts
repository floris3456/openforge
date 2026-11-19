export * as Shell from "./shell.js"

import { mkdir } from "fs/promises"
import path from "path"
import { Context, Duration, Effect, Layer, Schedule, Schema, Stream } from "effect"
import { Shell } from "@opencode/schema/shell"
import { AppProcess } from "@opencode/util/process"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import type { Agent } from "./agent.js"
import { Environment } from "./environment/index.js"
import { FileRetention } from "./file-retention.js"
import { Location } from "./location.js"
import { ShellSelect } from "./shell/select.js"
import { PluginHooks } from "./plugin/hooks.js"
import { SessionEnvironment } from "./session/environment.js"
import { SessionSchema } from "./session/schema.js"
import { Config } from "./config.js"
import { ToolOutput } from "./tool-output.js"
import { ShellInProcess } from "./shell/in-process.js"
import { ShellResult } from "./shell/result.js"
import { ShellRunner } from "./shell/runner.js"
import { ShellWrap } from "./shell/wrap.js"

export { NotFoundError, RunnerStoppedError } from "./shell/runner.js"
export const ID = Shell.ID
export type ID = Shell.ID
export const Info = Shell.Info
export type Info = Shell.Info
export const Event = Shell.Event

export const RETENTION = Duration.days(7)
const SPAN_COMMAND_LIMIT = 200
/** How far back from the end a single cut-off line's start is looked for. */
const LINE_START_SCAN_LIMIT = 1024 * 1024
export const DIRECTORY = ShellRunner.DIRECTORY

type CreateInput = Shell.CreateInput & {
  shell?: string
  /** The agent whose sandbox confines the command; a command without one (the user's) runs as it is. */
  agent?: Agent.ID
  /** Runs an agent's command outside its sandbox; the shell tool asks the user first. */
  unsandboxed?: boolean
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
  // With `wait`, stops waiting for the exit after that long and returns the output so far, still running.
  readonly result: (
    started: Shell.Info,
    options?: { readonly wait?: Duration.Input },
  ) => Effect.Effect<ShellResult.Result, ShellRunner.RunnerStoppedError>
  // Replaces the running command's timeout from now; zero clears it. Ignored once the command has ended.
  readonly timeout: (id: Shell.ID, duration: number) => Effect.Effect<Shell.Info, ShellRunner.NotFoundError>
  readonly output: (id: Shell.ID, input?: Shell.OutputInput) => Effect.Effect<Shell.Output, ShellRunner.NotFoundError>
  // Output as it arrives from `cursor` on, then the terminal Info.
  readonly watch: (id: Shell.ID, input?: Shell.WatchInput) => Stream.Stream<Shell.WatchEvent, ShellRunner.NotFoundError>
  readonly remove: (id: Shell.ID) => Effect.Effect<void, ShellRunner.NotFoundError>
  // Stops a running command (SIGTERM, then SIGKILL) without forgetting it: it stays observable, file included. Returns
  // at once; `wait` observes the exit. Ignored once the command has ended.
  readonly stop: (id: Shell.ID) => Effect.Effect<Shell.Info, ShellRunner.NotFoundError>
  // How the commands of an agent are confined here, worked out once per change of the config or the agent.
  readonly confinement: (agent: Agent.ID) => Effect.Effect<ShellWrap.Confinement>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Shell") {}

export const cleanup = Effect.fn("Shell.cleanup")(function* () {
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const directory = path.join(global.data, DIRECTORY)
  const projects = yield* fs.readDirectoryEntries(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => entry.type === "Directory")),
    Effect.orElseSucceed(() => []),
  )
  const files = yield* Effect.forEach(
    projects,
    (project) =>
      fs.readDirectoryEntries(path.join(directory, project.name)).pipe(
        Effect.map((entries) =>
          entries.flatMap((entry) =>
            entry.type === "File" && /^sh_[0-9a-f]{12}.*\.(out|exit|tmp)$/.test(entry.name)
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
      const ref = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })

      const outputDir = path.join(global.data, DIRECTORY, location.project.id)
      yield* Effect.promise(() => mkdir(outputDir, { recursive: true }))

      // Where the output's last line starts, found by reading back from the end; only needed to size a single cut-off
      // line. A start further back than LINE_START_SCAN_LIMIT is unknown.
      const lastLineStart = Effect.fnUntraced(function* (id: Shell.ID, size: number, endsWithNewline: boolean) {
        const wanted = endsWithNewline ? 2 : 1
        const starts: number[] = []
        const floor = Math.max(0, size - LINE_START_SCAN_LIMIT)
        let end = size
        while (end > floor && starts.length < wanted) {
          const from = Math.max(floor, end - ToolOutput.MAX_BYTES)
          const chunk = yield* runner.output(id, { cursor: from, limit: end - from })
          const text = chunk.output
          for (let index = text.length - 1; index >= 0 && starts.length < wanted; index--)
            if (text[index] === "\n") starts.push(chunk.cursor - Buffer.byteLength(text.slice(index + 1)))
          if (chunk.cursor <= from) break
          end = from
        }
        return starts[wanted - 1] ?? (floor > 0 ? undefined : 0)
      })

      const result = Effect.fn("Shell.result")(function* (
        started: Shell.Info,
        options?: { readonly wait?: Duration.Input },
      ) {
        const waited =
          options?.wait === undefined
            ? runner.wait(started.id)
            : runner.wait(started.id).pipe(
                Effect.timeoutOption(options.wait),
                Effect.flatMap((info) => (info._tag === "Some" ? Effect.succeed(info.value) : runner.get(started.id))),
              )
        const info = yield* waited.pipe(
          Effect.catchTag("Shell.NotFoundError", () =>
            Effect.succeed({
              ...started,
              status: "killed" as const,
              time: { ...started.time, completed: Date.now() },
            }),
          ),
        )
        yield* annotate(info)
        const capture = yield* Effect.gen(function* () {
          const limits = Config.latest(yield* config.entries(), "tool_output")
          const maxLines = limits?.max_lines ?? ToolOutput.MAX_LINES
          const maxBytes = limits?.max_bytes ?? ToolOutput.MAX_BYTES
          const size = (yield* runner.output(info.id, { cursor: Number.MAX_SAFE_INTEGER })).size
          const start = Math.max(0, size - maxBytes)
          const page = (yield* runner.output(info.id, { cursor: start, limit: maxBytes })).output
          // Whether the window starts on a line boundary: the byte before it is a newline (upstream's rule).
          const partial = start > 0 && (yield* runner.output(info.id, { cursor: start - 1, limit: 1 })).output !== "\n"
          const endsWithNewline = page.endsWith("\n")
          const lines = page.split("\n")
          if (endsWithNewline) lines.pop()
          // Counted by the runner while the command printed, so a notice never rescans the output file.
          const total = (yield* runner.lines(info.id)) + (endsWithNewline ? 0 : 1)
          const suffix = `full output saved to ${info.file}]`
          if (partial && lines.length === 1) {
            const lineStart = yield* lastLineStart(info.id, size, endsWithNewline)
            const end = size - (endsWithNewline ? 1 : 0)
            const lineSize =
              lineStart === undefined
                ? `over ${formatSize(Math.min(end, LINE_START_SCAN_LIMIT))}`
                : formatSize(end - lineStart)
            return {
              output: `${lines[0]}\n\n[showing the last ${formatSize(Buffer.byteLength(lines[0]))} of line ${total} (${lineSize}); ${suffix}`,
              truncated: true,
            }
          }
          if (start > 0 || lines.length > maxLines) {
            // A window that starts mid-line drops that partial line so the line numbers stay exact.
            const kept = lines.slice(-Math.min(maxLines, lines.length - (partial ? 1 : 0)))
            return {
              output: `${kept.join("\n")}\n\n[showing lines ${total - kept.length + 1}-${total} of ${total}; ${suffix}`,
              truncated: true,
            }
          }
          return { output: page || "(no output)", truncated: false }
        }).pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(undefined)))
        const sandboxNote = yield* runner
          .sandboxNote(info.id)
          .pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(undefined)))
        return { info, capture, ...(sandboxNote ? { sandboxNote } : {}) }
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

        const command = yield* wrap.wrap(
          {
            argv: [invocation.shell, ...ShellSelect.args(invocation.shell, invocation.command)],
            cwd: invocation.cwd,
            env: Object.fromEntries(
              Object.entries(invocation.env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
            ),
          },
          { agent: input.agent, unsandboxed: input.unsandboxed },
        )
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
        const deadline = invocation.timeout > 0 ? started + invocation.timeout : undefined
        yield* annotate(info)
        if (location.workspaceID !== undefined || process.platform === "win32")
          return yield* ShellInProcess.start({
            info,
            location: ref,
            command,
            deadline,
            sandboxNote: command.sandboxNote,
          }).pipe(
            Effect.provideService(Environment.Service, environment),
            Effect.provideService(ShellRunner.Service, runner),
          )
        return yield* runner.start({
          info,
          location: ref,
          sandboxNote: command.sandboxNote,
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
        stop: runner.stop,
        confinement: wrap.confinement,
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

// Upstream's span attributes. Spans carry only the command text, truncated; never env, stdin or output. Shells outlive
// the turn that started them, so the session comes from the shell's own metadata rather than the caller's span
// annotations.
function annotate(info: Shell.Info) {
  const sessionID = info.metadata.sessionID
  return Effect.annotateCurrentSpan({
    "opencode.shell.id": info.id,
    "opencode.shell.command": spanCommand(info.command),
    ...(typeof sessionID === "string" ? { "session.id": sessionID } : {}),
    ...(info.metadata.background === true ? { "opencode.shell.background": true } : {}),
    ...(info.status === "running" ? {} : { "opencode.shell.status": info.status }),
    ...(info.exit === undefined ? {} : { "process.exit.code": info.exit }),
  })
}

// Strict OTLP JSON parsers reject a lone surrogate, which a cut through an emoji would leave.
function spanCommand(command: string) {
  if (command.length <= SPAN_COMMAND_LIMIT) return command.toWellFormed()
  return `${command.slice(0, SPAN_COMMAND_LIMIT).toWellFormed()}…`
}

function formatSize(bytes: number) {
  const kb = bytes / 1024
  return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`
}
