export * as PacerRoute from "./route.js"

import {
  LanguageModel,
  type AIError,
  type CompactionCheckpointResponse,
  type CompactionResponse,
  type LLMRequest,
} from "@opencode/ai/effect"
import type {
  CheckpointRequest,
  CompactionRequest,
  EndpointCompactOptions,
  LLMClientService,
  TriggerCompactOptions,
} from "@opencode/ai/route"
import { Effect, Stream } from "effect"
import { PacerEndpoint } from "./endpoint.js"

type Client = LLMClientService["Service"]
type TriggerCompact = [request: LLMRequest & Pick<CheckpointRequest, "model">, options: TriggerCompactOptions]
type EndpointCompact = [request: LLMRequest & Pick<CompactionRequest, "model">, options?: EndpointCompactOptions]
const triggers = (args: TriggerCompact | EndpointCompact): args is TriggerCompact => args[1]?.mechanism === "trigger"

/**
 * The model client with every CLIProxyPacer request sent to where CPP is reached now. A model's address is fixed when
 * the provider builds it, from settings the provider's reload updates on its own fiber; a request whose route is on
 * one of CPP's addresses goes to the current endpoint instead, so a retry right after a move (a step's, a compaction's)
 * goes to the new address. Mapped before the route prepares the request, so its HTTP URL and its WebSocket channel's
 * both follow.
 */
export const client = (llm: Client, endpoints: PacerEndpoint.Interface): Client => {
  function compact(...args: TriggerCompact): Effect.Effect<CompactionCheckpointResponse, AIError>
  function compact(...args: EndpointCompact): Effect.Effect<CompactionResponse, AIError>
  function compact(...args: TriggerCompact | EndpointCompact) {
    if (triggers(args)) return Effect.flatMap(current(endpoints, args[0]), (request) => llm.compact(request, args[1]))
    return Effect.flatMap(current(endpoints, args[0]), (request) => llm.compact(request, args[1]))
  }
  return {
    stream: (request, options) =>
      Stream.unwrap(Effect.map(current(endpoints, request), (mapped) => llm.stream(mapped, options))),
    generate: (request, options) =>
      Effect.flatMap(current(endpoints, request), (mapped) => llm.generate(mapped, options)),
    compact,
  }
}

/**
 * `request` with its route's base URL on the current endpoint, when it is a CLIProxyPacer request whose base URL is
 * on another of CPP's addresses; unchanged otherwise (another provider, an address CPP did not name, one address).
 */
export const current = <R extends LLMRequest>(endpoints: PacerEndpoint.Interface, request: R) =>
  Effect.gen(function* () {
    const base = request.model.route.endpoint.baseURL
    if (String(request.model.provider) !== PacerEndpoint.id || base === undefined || !endpoints.addresses)
      return request
    const now = yield* endpoints.get()
    if (!now) return request
    // The longest root that holds the base URL, should one address's path lie under another's.
    const from = (yield* endpoints.addresses())
      .filter((address) => base === address.root || base.startsWith(`${address.root}/`))
      .reduce<
        PacerEndpoint.Address | undefined
      >((best, address) => (best && best.root.length >= address.root.length ? best : address), undefined)
    if (!from || from.root === now.root) return request
    const route = request.model.route.with({ endpoint: { baseURL: now.root + base.slice(from.root.length) } })
    return { ...request, model: new LanguageModel({ ...LanguageModel.input(request.model), route }) }
  })
