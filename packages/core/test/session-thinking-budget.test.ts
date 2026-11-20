import { describe, expect, test } from "bun:test"
import { ai, LanguageModel, type LLMRequest } from "@opencode/ai/effect"
import { AnthropicMessages, BedrockConverse, OpenAIChat } from "@opencode/ai/protocols"
import type { AnyRoute } from "@opencode/ai/route"
import { compileRequest } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionThinkingBudget } from "@opencode/core/session/thinking-budget"
import { DateTime, Effect, Schema } from "effect"
import { it } from "./lib/effect"

type Limit = SessionThinkingBudget.Chat["limit"]
const limit = { context: 200_000, output: 32_000 }
// Where a chat on a 200k window compacts with 15% of it kept free.
const threshold = 170_000
const claude = (thinking: unknown, route: AnyRoute = AnthropicMessages.route) =>
  LanguageModel.make({
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    route,
    options: { providerOptions: { thinking } },
  })
const manual = claude({ type: "enabled", budgetTokens: 16_000 })
/** A step whose own new messages are put at `estimated` after the chat's latest measured size `measured`. */
const step = (
  model: LanguageModel,
  measured: number,
  options: { estimated?: number; window?: Limit; providerOptions?: LLMRequest["providerOptions"] } = {},
) =>
  ai.request({
    model,
    prompt: "Continue",
    maxTokens: SessionModelRequest.outputLimit(
      options.window ?? limit,
      { measured, estimated: options.estimated ?? 500 },
      SessionModelRequest.WINDOW_HEADROOM,
    ),
    providerOptions: options.providerOptions,
  })
const chat = (peak: number | undefined, compacts?: number, window: Limit = limit) => ({
  limit: window,
  peak,
  threshold: compacts,
  output: SessionModelRequest.outputLimit(window),
  headroom: SessionModelRequest.WINDOW_HEADROOM,
})
const sent = (request: LLMRequest) =>
  compileRequest(request).pipe(
    Effect.map((compiled) => (compiled.body as { thinking?: Record<string, unknown> }).thinking),
  )
const budgets = (requests: ReadonlyArray<LLMRequest>) =>
  Effect.forEach(requests, (request) => sent(request).pipe(Effect.map((thinking) => thinking?.budget_tokens)))

describe("SessionThinkingBudget.keep", () => {
  test("a step far from the window is the request its route sends today, the very same", () => {
    for (const peak of [undefined, 0, 100_000, 157_000])
      for (const compacts of [undefined, threshold]) {
        const request = step(manual, peak ?? 0)
        expect(SessionThinkingBudget.keep(request, chat(peak, compacts))).toBe(request)
      }
  })

  test("a request without a manual budget is left as it is, near the window too", () => {
    for (const model of [
      claude({ type: "adaptive", display: "summarized" }),
      claude({ type: "disabled" }),
      claude(undefined),
      LanguageModel.make({
        id: "gpt-5",
        provider: "openai",
        route: OpenAIChat.route,
        options: { providerOptions: { thinking: { type: "enabled", budgetTokens: 16_000 } } },
      }),
    ]) {
      const request = step(model, 168_000)
      expect(SessionThinkingBudget.keep(request, chat(168_000, threshold))).toBe(request)
    }
    const unlimited = { ...step(manual, 168_000), maxTokens: undefined }
    expect(SessionThinkingBudget.keep(unlimited, chat(168_000, threshold))).toBe(unlimited)
  })

  it.effect("once the chat's budget no longer fits, it is the most that fits at its compaction point, kept", () =>
    Effect.gen(function* () {
      // 198,000 of the window, less the largest size, less the 4,096 margin, must hold twice the budget; at 170k that
      // leaves 23,904, so 11,952.
      const peaks = [157_000, 162_500, 166_500, 169_500]
      expect(
        yield* budgets(peaks.map((peak) => SessionThinkingBudget.keep(step(manual, peak), chat(peak, threshold)))),
      ).toEqual([16_000, 11_952, 11_952, 11_952])
      // At 172k a step's output limit has 26,000 left, as it keeps 1% of the window free: 10,952.
      expect(yield* budgets([SessionThinkingBudget.keep(step(manual, 166_500), chat(166_500, 172_000))])).toEqual([
        10_952,
      ])
    }),
  )

  it.effect("a large budget changes once too", () =>
    Effect.gen(function* () {
      const window = { context: 200_000, output: 64_000 }
      const model = claude({ type: "enabled", budgetTokens: 31_999 })
      const peaks = [120_000, 131_000, 150_000, 169_000]
      expect(
        yield* budgets(
          peaks.map((peak) => SessionThinkingBudget.keep(step(model, peak, { window }), chat(peak, threshold, window))),
        ),
      ).toEqual([31_999, 11_952, 11_952, 11_952])
    }),
  )

  it.effect("without automatic compaction the budget halves whenever it no longer fits", () =>
    Effect.gen(function* () {
      const peaks = [157_000, 162_500, 166_500, 170_000, 177_500, 178_500]
      expect(yield* budgets(peaks.map((peak) => SessionThinkingBudget.keep(step(manual, peak), chat(peak))))).toEqual([
        16_000, 8_000, 8_000, 8_000, 8_000, 4_000,
      ])
    }),
  )

  it.effect("past the compaction point, as when compacting failed, the budget fitted there halves", () =>
    Effect.gen(function* () {
      expect(yield* budgets([SessionThinkingBudget.keep(step(manual, 176_000), chat(176_000, threshold))])).toEqual([
        5_976,
      ])
    }),
  )

  it.effect("a step whose own new messages outgrow the room gets the budget that fits at the compaction point", () =>
    Effect.gen(function* () {
      const request = step(manual, 140_000, { estimated: 25_000 })
      expect(request.maxTokens).toBe(29_250)
      expect(yield* budgets([SessionThinkingBudget.keep(request, chat(140_000, threshold))])).toEqual([11_952])
      // Without a compaction point, the half of the chat's own its output limit holds.
      expect(yield* budgets([SessionThinkingBudget.keep(request, chat(140_000))])).toEqual([8_000])
    }),
  )

  it.effect("a budget the output limit can't hold is the route's fit far from the window, and halves from there", () =>
    Effect.gen(function* () {
      const window = { context: 64_000, output: 16_000 }
      const model = claude({ type: "enabled", budgetTokens: 15_999 })
      const far = step(model, 20_000, { window })
      expect(SessionThinkingBudget.keep(far, chat(20_000, undefined, window))).toBe(far)
      expect(yield* budgets([far])).toEqual([8_000])
      expect(
        yield* budgets([SessionThinkingBudget.keep(step(model, 45_000, { window }), chat(45_000, undefined, window))]),
      ).toEqual([4_000])
    }),
  )

  it.effect("keeps the request's own thinking options beside the budget it sets", () =>
    Effect.gen(function* () {
      const request = step(manual, 168_000, {
        providerOptions: { thinking: { type: "enabled", budgetTokens: 16_000, display: "omitted" } },
      })
      expect(yield* sent(SessionThinkingBudget.keep(request, chat(168_000, threshold)))).toEqual({
        type: "enabled",
        budget_tokens: 11_952,
        display: "omitted",
      })
    }),
  )

  test("keeps Bedrock's Claude budget the same way", () => {
    const model = claude({ type: "enabled", budgetTokens: 16_000 }, BedrockConverse.route)
    expect(SessionThinkingBudget.keep(step(model, 168_000), chat(168_000, threshold)).providerOptions).toEqual({
      thinking: { budgetTokens: 11_952 },
    })
  })
})

const assistant = (size: number, model = "claude-sonnet-4-5", error?: { type: string; message: string }) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.defaultID,
    model: { id: model, providerID: "anthropic" },
    content: [{ type: "text", text: "Answer" }],
    tokens: { input: size - 300, output: 200, reasoning: 100, cache: { read: 0, write: 0 } },
    ...(error ? { error } : {}),
    time: { created: 0, completed: 1 },
  })
const compaction = SessionMessage.CompactionCompleted.make({
  id: SessionMessage.ID.create(),
  type: "compaction",
  status: "completed",
  reason: "auto",
  summary: "## Objective\n- Continue",
  time: { created: DateTime.makeUnsafe(0) },
})
const ref = Model.Ref.make({ id: Model.ID.make("claude-sonnet-4-5"), providerID: Provider.ID.make("anthropic") })

describe("SessionThinkingBudget.peak", () => {
  test("is the largest size the model's provider measured since the latest compaction, its answer included", () => {
    expect(SessionThinkingBudget.peak([assistant(150_000), assistant(170_000), assistant(160_000)], ref)).toBe(170_000)
    expect(SessionThinkingBudget.peak([assistant(190_000), compaction, assistant(20_000)], ref)).toBe(20_000)
    expect(SessionThinkingBudget.peak([assistant(190_000), compaction], ref)).toBeUndefined()
  })

  test("leaves out failed steps and other models' counts", () => {
    expect(
      SessionThinkingBudget.peak(
        [
          assistant(30_000),
          assistant(180_000, "claude-opus-4-5"),
          assistant(170_000, "claude-sonnet-4-5", { type: "provider.unknown", message: "failed" }),
        ],
        ref,
      ),
    ).toBe(30_000)
  })
})
