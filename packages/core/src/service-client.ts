export * as ServiceClient from "./service-client.js"

import { LLMClient, RequestExecutor, type LLMClientService } from "@opencode/ai/route"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Effect, Layer } from "effect"
import { SessionContinuity } from "./continuity.js"
import { requestExecutor } from "./effect/app-node-platform.js"
import { PacerEndpoint } from "./pacer/endpoint.js"
import { PacerRoute } from "./pacer/route.js"

/**
 * The model client where the service runs, in place of `LayerNodePlatform.llmClient`: `base`, the real client unless
 * a test gives its fake, with every call gated by `SessionContinuity`'s `client` and every CLIProxyPacer request sent
 * to where CPP is reached now (`PacerRoute.client`). Not in continuity.ts: PacerEndpoint's imports lead back to it.
 */
export const llm = (base: Layer.Layer<LLMClientService, never, RequestExecutor.Service> = LLMClient.layer) =>
  makeGlobalNode({
    service: LLMClient.Service,
    layer: Layer.effect(
      LLMClient.Service,
      Effect.gen(function* () {
        const continuity = yield* SessionContinuity.Service
        const endpoints = yield* PacerEndpoint.Service
        const llm = yield* LLMClient.Service
        return continuity.client(PacerRoute.client(llm, endpoints))
      }),
    ).pipe(Layer.provide(base)),
    deps: [SessionContinuity.node, requestExecutor, PacerEndpoint.node],
  })
