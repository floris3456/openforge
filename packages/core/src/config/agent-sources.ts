export * as ConfigAgentSources from "./agent-sources.js"

import { Context, Effect, Layer, type Scope } from "effect"
import type { Document } from "@opencode/schema/config"
import { makeLocationNode } from "@opencode/util/effect/app-node"

// openforge: the documents a Location's agents were loaded from, config documents and agent files, as the agent config
// plugin holds them. What only those files know is read from here, never from the public agent info: the file that
// sets each of an agent's own Code Mode pins, which CLIProxyPacer is told (`X-Pacer-Pins`).

export interface Interface {
  /** The documents, lowest priority first; none before the agent config plugin loaded them. */
  readonly documents: () => ReadonlyArray<Document>
  /** The agent config plugin's: `documents` answers from `load` for as long as the scope lasts. */
  readonly hold: (load: () => ReadonlyArray<Document>) => Effect.Effect<void, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ConfigAgentSources") {}

const layer = Layer.sync(Service, () => {
  const state = { load: undefined as (() => ReadonlyArray<Document>) | undefined }
  return Service.of({
    documents: () => state.load?.() ?? [],
    hold: (load) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          state.load = load
        }),
        () =>
          Effect.sync(() => {
            if (state.load === load) state.load = undefined
          }),
      ).pipe(Effect.asVoid),
  })
})

export const node = makeLocationNode({ service: Service, layer, deps: [] })
