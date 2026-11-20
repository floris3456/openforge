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

const limit = { context: 200_000, output: 32_000 }
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
  estimated = 500,
  providerOptions?: LLMRequest["providerOptions"],
) =>
  ai.request({
    model,
    prompt: "Continue",
    maxTokens: SessionModelRequest.outputLimit(limit, { measured, estimated }, SessionModelRequest.WINDOW_HEADROOM),
    providerOptions,
  })
const chat = (peak: number | undefined, window = limit) => ({
  limit: window,
  peak,
  output: SessionModelRequest.outputLimit(window),
  headroom: SessionModelRequest.WINDOW_HEADROOM,
})
const sent = (request: LLMRequest) =>
  compileRequest(request).pipe(
    Effect.map((compiled) => (compiled.body as { thinking?: Record<string, unknown> }).thinking),
  )

describe("SessionThinkingBudget.keep", () => {
  test("a step far from the window is the request its route sends today, the very same", () => {
    for (const peak of [undefined, 0, 100_000, 157_000]) {
      const request = step(manual, peak ?? 0)
      expect(SessionThinkingBudget.keep(request, chat(peak))).toBe(request)
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
      const request = step(model, 170_000)
      expect(SessionThinkingBudget.keep(request, chat(170_000))).toBe(request)
    }
    const unlimited = { ...step(manual, 170_000), maxTokens: undefined }
    expect(SessionThinkingBudget.keep(unlimited, chat(170_000))).toBe(unlimited)
  })

  it.effect(
    "halves the budget once the room the chat's largest size leaves can't hold it, and keeps it while it can",
    () =>
      Effect.gen(function* () {
        // 198,000 of the window, less the largest size, less the 4,096 margin, must hold twice the budget.
        const budgets = yield* Effect.forEach([157_000, 162_500, 166_500, 170_000, 177_500, 178_500], (peak) =>
          sent(SessionThinkingBudget.keep(step(manual, peak), chat(peak))).pipe(
            Effect.map((thinking) => thinking?.budget_tokens),
          ),
        )
        expect(budgets).toEqual([16_000, 8_000, 8_000, 8_000, 8_000, 4_000])
      }),
  )

  it.effect("a step whose own new messages outgrow the room lowers its budget to the half its output limit holds", () =>
    Effect.gen(function* () {
      const request = SessionThinkingBudget.keep(step(manual, 150_000, 25_000), chat(150_000))
      expect(request.maxTokens).toBe(19_250)
      expect((yield* sent(request))?.budget_tokens).toBe(8_000)
    }),
  )

  it.effect("a budget the output limit can't hold is the route's fit far from the window, and halves from there", () =>
    Effect.gen(function* () {
      const window = { context: 64_000, output: 16_000 }
      const model = claude({ type: "enabled", budgetTokens: 15_999 })
      const request = (measured: number) =>
        ai.request({
          model,
          prompt: "Continue",
          maxTokens: SessionModelRequest.outputLimit(
            window,
            { measured, estimated: 500 },
            SessionModelRequest.WINDOW_HEADROOM,
          ),
        })
      const far = request(20_000)
      expect(SessionThinkingBudget.keep(far, chat(20_000, window))).toBe(far)
      expect((yield* sent(far))?.budget_tokens).toBe(8_000)
      expect((yield* sent(SessionThinkingBudget.keep(request(45_000), chat(45_000, window))))?.budget_tokens).toBe(
        4_000,
      )
    }),
  )

  it.effect("keeps the request's own thinking options beside the budget it sets", () =>
    Effect.gen(function* () {
      const request = step(manual, 170_000, 500, {
        thinking: { type: "enabled", budgetTokens: 16_000, display: "omitted" },
      })
      expect(yield* sent(SessionThinkingBudget.keep(request, chat(170_000)))).toEqual({
        type: "enabled",
        budget_tokens: 8_000,
        display: "omitted",
      })
    }),
  )

  test("keeps Bedrock's Claude budget the same way", () => {
    const model = claude({ type: "enabled", budgetTokens: 16_000 }, BedrockConverse.route)
    expect(SessionThinkingBudget.keep(step(model, 170_000), chat(170_000)).providerOptions).toEqual({
      thinking: { budgetTokens: 8_000 },
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
