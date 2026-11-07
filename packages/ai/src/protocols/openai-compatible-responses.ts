import { Route } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { OpenResponses } from "./open-responses.js"
import type { CompactOperation } from "../route/client.js"
import { OpenAIFreeform } from "./openai-freeform.js"
import { ProviderShared } from "./shared.js"
import { ResponsesCompaction } from "./utils/responses-compaction.js"

const ADAPTER = "openai-compatible-responses"

/**
 * Deployment adapter for providers that expose an Open Responses-compatible
 * `/responses` endpoint. Provider helpers configure identity, endpoint, and
 * auth while the semantic protocol remains provider-neutral.
 */
export const route = Route.make({
  id: ADAPTER,
  providerMetadataKey: "openresponses",
  protocol: OpenResponses.protocol,
  endpoint: Endpoint.path(OpenResponses.PATH),
  transport: OpenResponses.httpTransport,
  defaults: { providerOptions: { store: false, include: ["reasoning.encrypted_content"] } },
})

// Open Responses' own adapter, as `OpenResponses.fromRequest` lowers a turn of this route.
const turnAdapter: OpenResponses.ProviderAdapter = { id: "open-responses", name: "Open Responses" }
const compactEndpoint = ResponsesCompaction.make(turnAdapter, (request) =>
  OpenResponses.lowerTools(ProviderShared.flattenTools(request.tools), turnAdapter, OpenAIFreeform.tools(request)),
)

/**
 * `POST <endpoint>/compact` (fork, spec cliproxypacer-server-summaries): upstream's `ResponsesCompaction` over the
 * lowering a turn of this route gets (`OpenResponses.fromRequest`, which flattens toolsets), so its conversation,
 * instructions and tools are the turn's bytes as far as `/compact` takes them, and a warm prompt cache is read. Not on
 * `route`, since few such endpoints have it: a provider whose endpoint does sets it
 * (`route.with({ compact: { endpoint: compact } })`).
 */
export const compact: CompactOperation = (request, executor, options) =>
  compactEndpoint(ProviderShared.flattenToolRequest(request).request, executor, options)

export * as OpenAICompatibleResponses from "./openai-compatible-responses.js"
