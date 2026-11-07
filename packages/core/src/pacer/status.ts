export * as PacerStatus from "./status.js"

import { Clock, Context, Effect, Layer } from "effect"
import type { Pacer } from "@opencode/schema/pacer"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

// The connection's state, held where those who can't depend on the connection read it: compaction asks CPP to write a
// summary only while it is `on` (spec cliproxypacer-server-summaries, section 1), and the connection depends on the
// session store, which compaction is part of. The connection (`connection.ts`) is its only writer.

export interface Interface {
  /** The connection's status now; `unset` until the connection sets one. */
  readonly get: () => Effect.Effect<Pacer.Status>
  /** The connection's: its status as it changes. */
  readonly set: (status: Pacer.Status) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PacerStatus") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let status: Pacer.Status = { state: "unset", since: yield* Clock.currentTimeMillis, refused: false }
    return Service.of({
      get: () => Effect.sync(() => status),
      set: (next) =>
        Effect.sync(() => {
          status = next
        }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
