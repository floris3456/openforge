export * as ShellWrap from "./wrap.js"

import type { Shell } from "@opencode/schema/shell"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import type { AppProcess } from "@opencode/util/process"
import { Context, Effect, Layer } from "effect"

/** The process a shell command runs as: what the runner executes, unchanged. */
export type Command = {
  readonly argv: readonly [string, ...string[]]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

export interface Interface {
  /**
   * Turns a shell command into the process that runs it, for example the sandbox command around it. Failing refuses
   * the command. `metadata` is the command's (the shell tool sets `sessionID`).
   */
  readonly wrap: (
    command: Command,
    context: { readonly metadata: Shell.Metadata },
  ) => Effect.Effect<Command, AppProcess.AppProcessError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShellWrap") {}

export const unwrapped = Layer.succeed(Service, Service.of({ wrap: (command) => Effect.succeed(command) }))

export const node = makeLocationNode({ service: Service, layer: unwrapped, deps: [] })
