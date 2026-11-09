import { Effect } from "effect"
import { Route } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import { LLMRequest } from "../schema/index.js"
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
const lowerTools = (request: LLMRequest) =>
  OpenResponses.lowerTools(ProviderShared.flattenTools(request.tools), turnAdapter, OpenAIFreeform.tools(request))
const compactEndpoint = ResponsesCompaction.make(turnAdapter, lowerTools)
const systemPartsEndpoint = ResponsesCompaction.make(turnAdapter, lowerTools, (request, adapter) => {
  // As a Messages turn has them: one system block per part with text.
  const parts = request.system.filter((part) => part.text.length > 0)
  return OpenResponses.lowerConversation(LLMRequest.update(request, { system: [] }), adapter).pipe(
    Effect.map((native) =>
      parts.length === 0
        ? native
        : {
            ...native,
            input: [
              {
                type: "message",
                role: "system",
                content: parts.map((part) => ({ type: "input_text", text: part.text })),
              },
              ...native.input,
            ],
          },
    ),
  )
})

/**
 * `POST <endpoint>/compact` (fork, spec cliproxypacer-server-summaries): upstream's `ResponsesCompaction` over the
 * lowering a turn of this route gets (`OpenResponses.fromRequest`, which flattens toolsets), so its conversation,
 * instructions and tools are the turn's bytes as far as `/compact` takes them, and a warm prompt cache is read. Not on
 * `route`, since few such endpoints have it: a provider whose endpoint does sets it
 * (`route.with({ compact: { endpoint: compact } })`).
 */
export const compact: CompactOperation = (request, executor, options) =>
  compactEndpoint(ProviderShared.flattenToolRequest(request).request, executor, options)

/**
 * {@link compact} for a turn that went out in another format, which the endpoint renders back into it (fork:
 * CLIProxyPacer's Claude chats speak Anthropic Messages). The turn's system parts go as the first input item, a `system`
 * message with one `input_text` per part, in order, instead of joined into `instructions`: CLIProxyPacer makes one
 * system block of each such part (`claude_responses.rs`), so the summary request's system blocks are the turn's, and
 * so is the prefix a cache reads. Their cache hints have no Responses form and stay out.
 */
export const compactSystemParts: CompactOperation = (request, executor, options) =>
  systemPartsEndpoint(ProviderShared.flattenToolRequest(request).request, executor, options)

export * as OpenAICompatibleResponses from "./openai-compatible-responses.js"
