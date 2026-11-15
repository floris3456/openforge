export * as MemoryTexts from "./texts.js"

import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { KV } from "../kv.js"
import { PacerEndpoint } from "../pacer/endpoint.js"
import { PacerModels } from "../pacer/models.js"
import { MemoryClient } from "./client.js"

// memory's texts for the moments openforge says something without CPP (workspace reference
// `docs/reference/cpp-tools-api.md`, `GET /pacer/v1/memory/texts`): the start block while memory cannot be reached, and
// what an edit outside a task answers. Read again at each catalog read of a server that serves memory's tools, and kept
// per endpoint across restarts, for when CPP cannot be reached.

/** How long a read may take. */
const TIMEOUT = "5 seconds"

export interface Interface {
  /** The texts the current endpoint last gave; undefined when it never did. Never fails. */
  readonly get: () => Effect.Effect<MemoryClient.Texts | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryTexts") {}

const Kept = Schema.Struct({ unavailable: Schema.String, refused: Schema.String })
const decodeKept = Schema.decodeUnknownOption(Kept)

export const key = (endpoint: PacerEndpoint.Endpoint) => `pacer:memory-texts:${endpoint.home ?? endpoint.root}`

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const endpoints = yield* PacerEndpoint.Service
    const catalogs = yield* PacerModels.Service
    const client = yield* MemoryClient.Service

    yield* catalogs.changes().pipe(
      Stream.runForEach((catalog) =>
        Effect.gen(function* () {
          const endpoint = yield* endpoints.get()
          if (!endpoint || catalog?.pacer?.memory?.tools !== true) return
          const texts = yield* client
            .texts({ timeout: TIMEOUT })
            .pipe(
              Effect.catch((error) =>
                Effect.logInfo("memory's texts could not be read", { reason: error.message }).pipe(
                  Effect.as(undefined),
                ),
              ),
            )
          // Kept only while the endpoint it was read from is still the current one.
          if (texts && PacerEndpoint.same(endpoint, yield* endpoints.get()))
            yield* kv.set(key(endpoint), { unavailable: texts.unavailable, refused: texts.refused })
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({
      get: Effect.fn("MemoryTexts.get")(function* () {
        const endpoint = yield* endpoints.get()
        if (!endpoint) return undefined
        return Option.getOrUndefined(decodeKept(yield* kv.get(key(endpoint))))
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [KV.node, PacerEndpoint.node, PacerModels.node, MemoryClient.node],
})
