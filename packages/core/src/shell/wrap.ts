export * as ShellWrap from "./wrap.js"

import { Sandbox } from "@opencode/sandbox"
import type { Shell } from "@opencode/schema/shell"
import { TuiEvent } from "@opencode/schema/tui-event"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Context, Effect, Layer } from "effect"
import { Agent } from "../agent.js"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Location } from "../location.js"

/** The process a shell command runs as: what the runner executes, unchanged. */
export type Command = {
  readonly argv: readonly [string, ...string[]]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

export type Wrapped = Command & {
  /** Set when the command runs in the sandbox: what the result of a failed command says about it. */
  readonly note?: string
}

export interface Interface {
  /**
   * Turns a shell command into the process that runs it, for example the sandbox command around it. Failing refuses
   * the command. `metadata` is the command's (the shell tool sets `sessionID` and `agent`).
   */
  readonly wrap: (
    command: Command,
    context: { readonly metadata: Shell.Metadata },
  ) => Effect.Effect<Wrapped, AppProcess.AppProcessError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShellWrap") {}

export const unwrapped = Layer.succeed(Service, Service.of({ wrap: (command) => Effect.succeed(command) }))

export const node = makeLocationNode({ service: Service, layer: unwrapped, deps: [] })

export type Options = {
  /** Starts this openforge, whose hidden `sandbox-exec` command confines a command on Linux. */
  readonly self: readonly string[]
  /** The live database, when it isn't `<data>/opencode.db`. */
  readonly database?: string
  /** Whether this machine can sandbox; the sandbox works it out itself when not given. */
  readonly machine?: Sandbox.Availability
}

/**
 * Confines the commands an agent runs: those whose metadata names its `agent`, unless they carry `sandbox: false`
 * (the shell tool asked for the `unsandboxed` permission first). Commands the user runs (`!`, the shell API) and those
 * of a workspace's own environment run as they are. The policy layers the config's `sandbox` settings, then the
 * agent's.
 */
export const sandboxed = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const agents = yield* Agent.Service
      const location = yield* Location.Service
      const global = yield* Global.Service
      const bus = yield* Bus.Service
      const ref = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })
      return Service.of({
        wrap: Effect.fn("ShellWrap.wrap")(function* (command, context) {
          const agent = context.metadata.agent
          if (typeof agent !== "string" || context.metadata.sandbox === false || location.workspaceID !== undefined)
            return command
          const layers = (yield* config.entries()).flatMap((entry) =>
            entry.type === "document" ? [entry.info.sandbox] : [],
          )
          const policy = Sandbox.resolve(Sandbox.merge(...layers, (yield* agents.get(Agent.ID.make(agent)))?.sandbox), {
            directory: location.directory,
            worktree: location.project.directory,
            home: global.home,
            data: global.data,
            state: global.state,
            config: global.config,
            ...(options.database ? { database: options.database } : {}),
            env: command.env,
          })
          const wrapped = Sandbox.wrap(policy, command.argv, options.self, options.machine)
          if (wrapped.type === "refuse")
            return yield* new AppProcess.AppProcessError({
              command: command.argv.join(" "),
              cause: new Error(wrapped.reason),
            })
          if (wrapped.warning) {
            yield* Effect.logWarning(wrapped.warning)
            yield* bus.publish(
              TuiEvent.ToastShow,
              { title: "Sandbox", message: wrapped.warning, variant: "warning", duration: 10_000 },
              { location: ref },
            )
          }
          if (!wrapped.sandboxed) return command
          const note = Sandbox.note(policy)
          return { ...command, argv: [wrapped.argv[0], ...wrapped.argv.slice(1)], ...(note ? { note } : {}) }
        }),
      })
    }),
  )

export const configured = (options: Options) =>
  makeLocationNode({
    service: Service,
    layer: sandboxed(options),
    deps: [Config.node, Agent.node, Location.node, Global.node, Bus.node],
  })
