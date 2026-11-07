import { expect } from "bun:test"
import { Effect } from "effect"
import { ai, LanguageModel, LLMRequest, Message, ToolDefinition } from "../../src/effect.js"
import { LLMClient } from "../../src/route/client.js"
import { OpenAICompatibleResponses as Protocol } from "../../src/protocols/openai-compatible-responses.js"
import { OpenAICompatibleResponses } from "../../src/providers/index.js"
import { testEffect } from "../lib/effect.js"
import { dynamicResponse, json, observe, type Call } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

// The fork's `/responses/compact` for an Open Responses-compatible endpoint (spec cliproxypacer-server-summaries,
// section 3, "The body"): a turn's own bytes as far as `/compact` takes them, so a warm prompt cache is read. The
// answer is CLIProxyPacer's readable one: a user message with the summary, then a compaction item.

const calls: Call[] = []
const summary = "Context summary from previous turns:\nThe user asked for a plan; the assistant gave one."
const answer = {
  object: "response.compaction",
  status: "completed",
  id: "resp_cpa_compact_1",
  model: "fixture-model",
  output: [
    {
      type: "message",
      role: "user",
      id: "msg_cpa_compact_1",
      status: "completed",
      content: [{ type: "input_text", text: summary }],
    },
    { type: "compaction", id: "cmp_cpa_compact_1", encrypted_content: "cpa-ag-compact-v1:stub" },
  ],
  usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 80, total_tokens: 1280 },
}

const it = testEffect(
  dynamicResponse((input) =>
    Effect.gen(function* () {
      const { call } = yield* observe(calls, input)
      if (new URL(call.url).pathname.endsWith("/responses/compact")) return json(input, answer)
      return input.respond(sseEvents({ type: "response.completed", response: { id: "resp_turn", output: [] } }), {
        headers: { "content-type": "text/event-stream" },
      })
    }),
  ),
)

const model = OpenAICompatibleResponses.configure({
  apiKey: "test-key",
  baseURL: "https://proxy.example/v1",
  provider: "cliproxypacer",
}).model("fixture-model")

const request = ai.request({
  model,
  system: "You are a coding agent.",
  promptCacheKey: "fixture-cache-key",
  generation: { maxTokens: 4_000 },
  tools: [
    ToolDefinition.make({
      name: "read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }),
  ],
  messages: [
    Message.user("Plan a dark mode."),
    Message.assistant([
      { type: "text", text: "Reading the styles first." },
      { type: "tool-call", id: "call_1", name: "read", input: { path: "styles.css" } },
    ]),
    Message.make({
      role: "tool",
      content: [{ type: "tool-result", id: "call_1", name: "read", result: { type: "text", value: "body {}" } }],
    }),
    Message.assistant("Here is the plan."),
  ],
})

it.effect("sends a turn's conversation, instructions and tools to <endpoint>/compact, byte for byte", () =>
  Effect.gen(function* () {
    calls.length = 0
    yield* LLMClient.generate(request)
    const compacting = LanguageModel.update(model, {
      route: model.route.with({ compact: { endpoint: Protocol.compact } }),
    })
    const withCompact = LLMRequest.update(request, { model: compacting })
    expect(ai.canCompact(withCompact)).toBe(true)
    if (!ai.canCompact(withCompact)) return
    const response = yield* ai.compact(withCompact)

    const [turn, compaction] = calls
    expect(new URL(turn!.url).pathname).toBe("/v1/responses")
    expect(new URL(compaction!.url).pathname).toBe("/v1/responses/compact")
    expect(compaction!.headers.get("authorization")).toBe("Bearer test-key")
    const step = JSON.parse(turn!.body) as Record<string, unknown>
    const compact = JSON.parse(compaction!.body) as Record<string, unknown>
    // The prefix a cache reads is the same text: instructions, tools, then the conversation.
    for (const key of ["model", "instructions", "tools", "input", "prompt_cache_key", "include"])
      expect(JSON.stringify(compact[key])).toBe(JSON.stringify(step[key]))
    expect(compact.input).toHaveLength(5)
    // What only a turn takes stays out.
    for (const key of ["stream", "max_output_tokens", "store", "tool_choice"]) expect(compact).not.toHaveProperty(key)

    // The readable answer: the summary as a user message, then the checkpoint.
    expect(response.replacement).toHaveLength(2)
    expect(response.replacement[0]?.role).toBe("user")
    expect(response.replacement[0]?.content).toEqual([{ type: "text", text: summary }])
    expect(response.replacement[1]?.content[0]).toMatchObject({ type: "compaction", id: "cmp_cpa_compact_1" })
    expect(response.usage?.inputTokens).toBe(1200)
    expect(response.usage?.cacheReadInputTokens).toBe(1000)
  }),
)

// For a turn that went out in another format, which the endpoint renders back (CLIProxyPacer's Claude chats speak
// Messages): CLIProxyPacer turns `instructions` into one system block and each text part of a `system` input item into
// one more (`claude_responses.rs`), so the turn's system parts go as such parts, in order, not joined.
it.effect("compactSystemParts: the system parts as a first system item, one input_text each; no instructions", () =>
  Effect.gen(function* () {
    const withSystem = (system: ReadonlyArray<string>, endpoint: typeof Protocol.compact) =>
      LLMRequest.update(request, {
        model: LanguageModel.update(model, { route: model.route.with({ compact: { endpoint } }) }),
        system: system.map((text) => ({ type: "text" as const, text })),
      })
    const bodyOf = (compacting: LLMRequest) =>
      Effect.gen(function* () {
        calls.length = 0
        if (!ai.canCompact(compacting)) throw new Error("not compactable")
        yield* ai.compact(compacting)
        return JSON.parse(calls[0]!.body) as Record<string, unknown>
      })
    const parts = ["You are a coding agent.\n", "# Your Model\n- fixture-model", "", "A worktree hint."]
    const joined = yield* bodyOf(withSystem(parts, Protocol.compact))
    const split = yield* bodyOf(withSystem(parts, Protocol.compactSystemParts))

    expect(joined.instructions).toBe(parts.join("\n"))
    expect(split).not.toHaveProperty("instructions")
    // The empty part makes no block, as in a Messages turn.
    expect(split.input).toEqual([
      {
        type: "message",
        role: "system",
        content: [
          { type: "input_text", text: "You are a coding agent.\n" },
          { type: "input_text", text: "# Your Model\n- fixture-model" },
          { type: "input_text", text: "A worktree hint." },
        ],
      },
      ...(joined.input as unknown[]),
    ])
    for (const key of ["model", "tools", "prompt_cache_key", "include"])
      expect(JSON.stringify(split[key])).toBe(JSON.stringify(joined[key]))

    // Without system parts: neither the item nor instructions.
    const bare = yield* bodyOf(withSystem([], Protocol.compactSystemParts))
    expect(bare).not.toHaveProperty("instructions")
    expect(bare.input).toEqual(joined.input)
  }),
)

it.effect("the route itself still has no compact endpoint: a provider that has one sets it", () =>
  Effect.sync(() => {
    expect(ai.canCompact(request)).toBe(false)
    expect(model.route.compact).toBeUndefined()
  }),
)
