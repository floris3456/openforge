export * as ShellWrap from "./wrap.js"

import { Sandbox } from "@opencode/sandbox"
import type { Entry } from "@opencode/schema/config"
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
  readonly sandboxNote?: string
}

/** How an agent's commands run here; the shell tool tells the model. */
export type Confinement =
  /** As they are: no sandbox here, it is off, or this machine can't sandbox and the config doesn't require it. */
  | { readonly type: "none" }
  | { readonly type: "sandbox"; readonly mode: "write" | "read"; readonly network: boolean }
  /** Not at all: this machine can't sandbox, and the config requires the sandbox. */
  | { readonly type: "refused"; readonly reason: string }

export interface Interface {
  /** How the commands of `agent` are confined, worked out once per change of the config or the agent. */
  readonly confinement: (agent: Agent.ID) => Effect.Effect<Confinement>
  /**
   * Turns a shell command into the process that runs it, for example the sandbox command around it. Failing refuses
   * the command. Only an agent's commands are confined, and not those the user allowed out (`unsandboxed`).
   */
  readonly wrap: (
    command: Command,
    context: { readonly agent?: Agent.ID; readonly unsandboxed?: boolean },
  ) => Effect.Effect<Wrapped, AppProcess.AppProcessError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShellWrap") {}

const unconfined: Confinement = { type: "none" }

export const node = makeLocationNode({
  service: Service,
  layer: Layer.succeed(
    Service,
    Service.of({ confinement: () => Effect.succeed(unconfined), wrap: (command) => Effect.succeed(command) }),
  ),
  deps: [],
})

export type Options = {
  /** Starts this openforge, whose hidden `sandbox-exec` command confines a command on Linux. */
  readonly self: readonly string[]
  /** The live database, when it isn't `<data>/opencode.db`. */
  readonly database?: string
  /** Whether this machine can sandbox, instead of its own answer; tests act out a machine that can't. */
  readonly machine?: Sandbox.Availability
}

/**
 * Confines the commands an agent runs, unless the shell tool asked the user to let one out (`unsandboxed`). Commands
 * the user runs (`!`, the shell API) and those of a workspace's own environment run as they are. The policy layers
 * the config's `sandbox` settings, then the agent's.
 */
const sandboxed = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const agents = yield* Agent.Service
      const location = yield* Location.Service
      const global = yield* Global.Service
      const bus = yield* Bus.Service
      const ref = Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID })
      const resolve = (entries: readonly Entry[], agent: Agent.Info | undefined, env?: Command["env"]) =>
        Sandbox.resolve(
          Sandbox.merge(
            ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info.sandbox] : [])),
            agent?.sandbox,
          ),
          {
            directory: location.directory,
            worktree: location.project.directory,
            home: global.home,
            data: global.data,
            state: global.state,
            config: global.config,
            ...(options.database ? { database: options.database } : {}),
            ...(env ? { env } : {}),
          },
        )
      // The config's documents and an agent are new objects after a change, so a confinement worked out from the
      // same ones still holds.
      const confined = new Map<
        Agent.ID,
        {
          readonly entries: readonly Entry[]
          readonly agent: Agent.Info | undefined
          readonly confinement: Confinement
        }
      >()

      return Service.of({
        confinement: Effect.fn("ShellWrap.confinement")(function* (id) {
          if (location.workspaceID !== undefined) return unconfined
          const entries = yield* config.entries()
          const agent = yield* agents.get(id)
          const known = confined.get(id)
          if (known?.entries === entries && known.agent === agent) return known.confinement
          const confinement = confine(resolve(entries, agent), options.machine ?? Sandbox.available())
          confined.set(id, { entries, agent, confinement })
          return confinement
        }),
        wrap: Effect.fn("ShellWrap.wrap")(function* (command, context) {
          if (context.agent === undefined || context.unsandboxed || location.workspaceID !== undefined) return command
          const agent = yield* agents.get(context.agent)
          const policy = resolve(yield* config.entries(), agent, command.env)
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
          const sandboxNote = Sandbox.note(policy)
          return {
            ...command,
            argv: [wrapped.argv[0], ...wrapped.argv.slice(1)],
            ...(sandboxNote ? { sandboxNote } : {}),
          }
        }),
      })
    }),
  )

// What Sandbox.wrap decides for a command, without spending the warning it gives once per process.
function confine(policy: Sandbox.Policy, machine: Sandbox.Availability): Confinement {
  if (policy.mode === "off") return unconfined
  if (!machine.ok) return policy.required ? { type: "refused", reason: machine.reason } : unconfined
  return { type: "sandbox", mode: policy.mode, network: policy.network }
}

export const configured = (options: Options) =>
  makeLocationNode({
    service: Service,
    layer: sandboxed(options),
    deps: [Config.node, Agent.node, Location.node, Global.node, Bus.node],
  })
