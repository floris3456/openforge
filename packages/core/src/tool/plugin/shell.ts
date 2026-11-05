export * as ShellTool from "./shell.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import { Sandbox } from "@opencode/sandbox"
import type { Tool } from "@opencode/schema/tool"
import { Deferred, Effect, Option, Schema, Scope } from "effect"
import { SessionContinuity } from "../../continuity.js"
import { Environment } from "../../environment/index.js"
import { Job } from "../../job.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { NonNegativeInt } from "../../schema.js"
import { Session } from "../../session.js"
import { SessionSchema } from "../../session/schema.js"
import { Shell } from "../../shell.js"
import { ShellParse } from "../../shell/parse.js"
import { ShellSelect } from "../../shell/select.js"
import { ShellResult } from "../../shell/result.js"
import type { ShellWrap } from "../../shell/wrap.js"

export const name = "shell"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000

const BACKGROUND_INSTRUCTION =
  "You will be notified automatically when the command finishes. The notification will include the command's output. Unless the user explicitly asks otherwise, DO NOT poll for completion, even if you need the final result to continue. Repeatedly sleeping and reading or searching the output file is polling, not useful work. You may read the current output if it lets you do useful work now, but do not repeatedly check it while waiting for the command to finish. Keep working on anything that does not depend on the result. If you have nothing else to do, end your response; you will be resumed automatically when the command finishes."
const OS =
  process.platform === "darwin"
    ? "macOS"
    : process.platform === "win32"
      ? "Windows"
      : process.platform === "linux"
        ? "Linux"
        : process.platform
// The same for every request until the settings change, so the prompt cache holds.
const description = (shell?: string, confinement: ShellWrap.Confinement = { type: "none" }) =>
  [
    "Execute a shell command and return its output.",
    ...(shell ? [`Commands run on ${OS} using ${shell}.`] : []),
    "Quote file paths containing spaces or special characters.",
    "Prefer dedicated tools over shell commands when possible.",
    "When output is large, the full result is saved to a file and a truncated preview is returned.",
    "Rely on automatic truncation unless filtering the output is more useful.",
    "Commands accept an optional timeout, background commands have no timeout by default.",
    "Background commands return immediately, and you will be notified when they complete.",
    ...sandboxDescription(confinement),
  ].join(" ")

const sandboxDescription = (confinement: ShellWrap.Confinement) => {
  if (confinement.type === "none") return []
  const leave = "run it again with `sandbox: false`, which asks the user for permission first."
  if (confinement.type === "refused")
    return [
      `This machine can't sandbox commands: ${confinement.reason}.`,
      `The config requires the sandbox, so to run a command, ${leave}`,
    ]
  const places =
    confinement.mode === "write"
      ? "the chat's folder, its git folders, the temp folder and the package caches, unless the config allows more"
      : "the temp folder"
  return [
    `Commands run in a sandbox that lets them write only to ${places}${confinement.network ? "" : ", and gives them no network"}.`,
    "When a sandboxed command fails, its result says where it may write.",
    `If the sandbox stopped a command that has to ${confinement.network ? "write elsewhere" : "write elsewhere or use the network"}, ${leave}`,
  ]
}

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.optionalKey(Schema.String).annotate({
    description:
      "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
  }),
  timeout: Schema.optionalKey(NonNegativeInt).annotate({
    description: `Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to ${DEFAULT_TIMEOUT_MS} for foreground commands. Background commands have no timeout by default.`,
  }),
  background: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
  }),
  sandbox: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Set to false to run the command outside the sandbox. Asks the user for permission first, so use it only when the sandbox stopped the command and it has to write outside the places the sandbox allows.",
  }),
})

/** What a foreground call stores while it waits for its command, so the next process waits for the same one. */
const Attached = Schema.Struct({ shellID: Shell.ID, timeout: NonNegativeInt })
const decodeAttached = Schema.decodeUnknownOption(Attached)

const StructuredOutput = Schema.Struct({
  exit: Schema.optionalKey(Schema.Number),
  signal: Schema.optionalKey(Schema.String),
  shellID: Schema.optionalKey(Schema.String),
  truncated: Schema.Boolean,
  timeout: Schema.optionalKey(Schema.Boolean),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  status: Schema.optionalKey(Schema.Literals(["completed", "running"])),
  /** Where a sandboxed command that failed may write, and how to go outside. */
  sandboxNote: Schema.optionalKey(Schema.String),
})

export type Output = typeof Output.Type

const resultMessages = (output: Output) => {
  const notice = output.status === "running" ? BACKGROUND_INSTRUCTION : ShellResult.notice(output)
  return [
    ...(output.output ? [output.output] : []),
    ...(notice ? [notice] : []),
    ...(output.sandboxNote ? [output.sandboxNote] : []),
  ]
}

/** What the model reads of a command's end, in a tool result or a notice. */
const resultText = (output: Output) => resultMessages(output).join("\n\n")

/** A finished command as the tool reports it. `timeout` is unknown for a command a restart picked up. */
const completed = (result: ShellResult.Result, timeout: number | undefined): Output => {
  const output = ShellResult.output(result)
  const sandboxNote = ShellResult.sandboxNote(result)
  const exceeded =
    timeout === undefined ? "Command exceeded its timeout." : `Command exceeded timeout of ${timeout} ms.`
  return {
    ...output,
    output: output.timeout
      ? `${output.output}\n\n${exceeded} Retry with a larger timeout if the command is expected to take longer.`
      : output.output,
    status: "completed",
    ...(sandboxNote ? { sandboxNote } : {}),
  }
}

/**
 * A shell job's work: the command's result, also kept in `settled` for its notice, as the text the job reports. An
 * interrupted job ends the command.
 */
export const follow = (
  shell: Shell.Interface,
  info: Shell.Info,
  settled: Deferred.Deferred<Output>,
  timeout: number | undefined,
) =>
  Effect.gen(function* () {
    const result = yield* shell.result(info)
    if (!result.capture) return yield* new Shell.NotFoundError({ id: info.id })
    return completed(result, timeout)
  }).pipe(
    Effect.tap((output) => Deferred.succeed(settled, output)),
    Effect.map(resultText),
    Effect.onInterrupt(() => shell.remove(info.id).pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.void))),
  )

/**
 * Admits a background command's end into its Session once its job has settled, then marks the notice delivered.
 * `resume` is asked as the notice is admitted: whether it wakes the Session (by default it does).
 */
export const notifyWhenDone = (
  jobs: Job.Interface,
  sessions: Session.Interface,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly jobID: string
    readonly shellID: string
    readonly command: string
    readonly settled: Deferred.Deferred<Output>
    readonly resume?: () => boolean
  },
) =>
  Effect.gen(function* () {
    const info = (yield* jobs.wait({ id: input.jobID })).info
    if (!info || info.status === "running") return
    const output = info.status === "completed" ? yield* Deferred.await(input.settled) : undefined
    const text = output ? resultText(output) : info.status === "error" ? (info.error ?? "Command failed") : "Cancelled"
    yield* sessions
      .synthetic({
        ...(info.notificationID ? { id: info.notificationID } : {}),
        sessionID: input.sessionID,
        description: input.command,
        ...ShellResult.notification({
          jobID: input.jobID,
          shellID: input.shellID,
          command: input.command,
          state: info.status,
          text,
          output,
        }),
        ...(input.resume?.() === false ? { resume: false } : {}),
      })
      .pipe(
        Effect.catchTag("Session.NotFoundError", () => Effect.void),
        Effect.orDie,
      )
    if (info.notificationID) yield* jobs.completeBackground(info.notificationID)
  })

const toolResult = (output: Output) => {
  return {
    output,
    content: resultMessages(output).map((text) => ({ type: "text" as const, text })),
    metadata: {
      status: output.status,
      ...ShellResult.metadata(output),
      ...(output.shellID !== undefined ? { shellID: output.shellID } : {}),
    },
  }
}

const backgroundResult = (shellID: string, file: string) => ({
  output: `Command moved to the background (shell ID: ${shellID}).\nOutput is streaming to: ${file}`,
  shellID,
  truncated: false,
  status: "running" as const,
})

export const Plugin = {
  id: "opencode.tool.shell",
  effect: Effect.fn("ShellTool.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const scope = yield* Scope.Scope
    const environment = yield* Environment.Service
    const access = yield* FileAccess.Service
    const shell = yield* Shell.Service
    const shellSelect = yield* ShellSelect.Service
    const compatibleShell = shellSelect.resolve({ priority: "compat" })
    const permission = yield* Permission.Service
    const continuity = yield* SessionContinuity.Service

    const prepare = Effect.fn("ShellTool.prepare")(function* (
      invocation: ShellCreateBefore,
      context: Tool.Context,
      unsandboxed: boolean,
    ) {
      const source = {
        type: "tool" as const,
        messageID: context.messageID,
        id: context.id,
      }
      const target = yield* access.resolve({ path: invocation.cwd, kind: "directory" })
      invocation.cwd = target.absolute
      const timeout = invocation.timeout
      const parsed = yield* ShellParse.scan(invocation.command, invocation.shell, target.absolute)
      const directories = yield* Effect.forEach(parsed.directories, (directory) =>
        access.resolve({
          path: FileAccess.resolvePath(target.absolute, directory),
          kind: "directory",
        }),
      )
      yield* access.authorizeExternal([target, ...directories], context)
      if (parsed.commands.length > 0)
        yield* permission.assert({
          action: name,
          resources: parsed.commands.map((command) => command.resource),
          save: parsed.commands.map((command) => command.save),
          sessionID: context.sessionID,
          agent: context.agent,
          source,
        })
      // Leaving a sandbox needs the permission; with none to leave there is nothing to ask.
      if (unsandboxed && (yield* shell.confinement(context.agent)).type !== "none")
        yield* permission.assert({
          action: Sandbox.permission,
          resources: [invocation.command],
          save: [invocation.command],
          sessionID: context.sessionID,
          agent: context.agent,
          source,
        })
      // Approval can outlive the directory, so validate immediately before spawning.
      const workdir = yield* Environment.typeFollowing(environment.files, target.absolute).pipe(
        Effect.catchTag("Environment.NotFound", () =>
          Effect.fail(new Error(`Working directory does not exist: ${target.absolute}`)),
        ),
      )
      if (workdir !== "directory")
        return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.absolute}`))
      return timeout
    })

    const notify = (sessionID: SessionSchema.ID, info: Shell.Info, jobID: string, settled: Deferred.Deferred<Output>) =>
      notifyWhenDone(jobs, sessions, { sessionID, jobID, shellID: info.id, command: info.command, settled }).pipe(
        Effect.forkIn(scope, { startImmediately: true }),
      )

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description: description(),
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              // A call a restart continues finds the command it started still running, or finished, in the runner.
              const attached = Option.getOrUndefined(decodeAttached(yield* continuity.resumed(context.id)))
              const timeout = input.background === true ? (input.timeout ?? 0) : (input.timeout ?? DEFAULT_TIMEOUT_MS)
              let finalTimeout = attached?.timeout ?? timeout
              const info = attached
                ? yield* shell.get(attached.shellID)
                : yield* shell.create(
                    {
                      command: input.command,
                      cwd: input.workdir,
                      timeout,
                      shell: yield* compatibleShell,
                      metadata: { sessionID: context.sessionID },
                      agent: context.agent,
                      unsandboxed: input.sandbox === false,
                    },
                    (invocation) =>
                      Effect.gen(function* () {
                        invocation.env.AGENT = "1"
                        invocation.env.OPENCODE = "1"
                        invocation.env.AI_AGENT ||= "opencode"
                        invocation.env.OPENCODE_SESSION_ID = context.sessionID
                        finalTimeout = yield* prepare(invocation, context, input.sandbox === false)
                      }),
                  )
              yield* context.progress({ shellID: info.id })

              const settled = yield* Deferred.make<Output>()
              const run = follow(shell, info, settled, finalTimeout)
              const job = yield* jobs.start({
                // CodeMode children share a tool-call ID, but each shell must own its job.
                id: info.id,
                type: name,
                title: info.command,
                metadata: { sessionID: context.sessionID, shellID: info.id },
                recovery: {
                  kind: "shell",
                  sessionID: context.sessionID,
                  shellID: info.id,
                  command: info.command,
                },
                run,
              })

              if (input.background === true) {
                yield* jobs.background(job.id)
                yield* notify(context.sessionID, info, job.id, settled)
                return backgroundResult(info.id, info.file)
              }

              // The wait survives a stop: the command keeps running in the runner, and the next process waits for it
              // again. A stop ends the job with its command still running; anything else that interrupts the wait
              // ends the command.
              const result = yield* continuity
                .wait(
                  context.id,
                  jobs
                    .block({ id: job.id, sessionID: context.sessionID })
                    .pipe(
                      Effect.flatMap((result) =>
                        result?.type === "finished" && result.info.status === "running"
                          ? Effect.interrupt
                          : Effect.succeed(result),
                      ),
                    ),
                  { shellID: info.id, timeout: finalTimeout },
                )
                .pipe(
                  Effect.onInterrupt(() =>
                    continuity.stopping() ? Effect.void : jobs.cancel(job.id).pipe(Effect.ignore),
                  ),
                )
              if (result?.type === "backgrounded") {
                yield* shell.timeout(info.id, 0)
                yield* notify(context.sessionID, info, job.id, settled)
                return backgroundResult(info.id, info.file)
              }
              if (result?.info.status === "error")
                return yield* Effect.fail(new Error(result.info.error ?? "Command failed"))
              if (result?.info.status === "cancelled") return yield* Effect.fail(new Error("Command cancelled"))

              return yield* Deferred.await(settled)
            }).pipe(
              Effect.map(toolResult),
              Effect.mapError(
                (error) => new ToolFailure({ message: `Unable to execute command: ${input.command}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        const confinement = yield* shell.confinement(event.agent)
        tool.description = description(ShellSelect.name(yield* compatibleShell), confinement)
        // With no sandbox to leave, the model is not offered the way out.
        const properties = tool.input.properties
        if (confinement.type === "none" && typeof properties === "object" && properties !== null)
          tool.input = {
            ...tool.input,
            properties: Object.fromEntries(Object.entries(properties).filter(([key]) => key !== "sandbox")),
          }
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
