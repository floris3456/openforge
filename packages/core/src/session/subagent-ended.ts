export * as SubagentEnded from "./subagent-ended.js"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import type { SessionSchema } from "./schema.js"

/**
 * openforge: what a child's report adds to its answer, such as memory's task line once its task is no longer active
 * (`MemoryTask.ended`). Known and left so: it lives in this process only, so a report after a restart has none.
 */
export type Ended = (output: string) => Effect.Effect<string>

export interface Interface {
  /** Each later report of `child` passes its answer through `ended`. */
  readonly set: (child: SessionSchema.ID, ended: Ended) => Effect.Effect<void>
  /** The answer `child`'s report carries. */
  readonly apply: (child: SessionSchema.ID, output: string) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentEnded") {}

export const layer = Layer.sync(Service, () => {
  const ended = new Map<SessionSchema.ID, Ended>()
  return Service.of({
    set: (child, value) => Effect.sync(() => void ended.set(child, value)),
    apply: (child, output) => ended.get(child)?.(output) ?? Effect.succeed(output),
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
