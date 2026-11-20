export * as SessionThinkingBudget from "./thinking-budget.js"

import type { LLMRequest, ProviderOptions } from "@opencode/ai/effect"
import { AnthropicMessages, BedrockConverse } from "@opencode/ai/protocols"
import { ProviderShared } from "@opencode/ai/route"
import type { Model } from "@opencode/schema/model"
import { Option, Predicate, Schema } from "effect"
import type { SessionMessage } from "./message.js"

// A manual thinking budget (Claude 4.5 and older) is rendered into the prompt, so a request with another budget than
// the one before misses every cached message (Anthropic's prompt caching, "What invalidates the cache"); the output
// limit is not part of it. The routes fit the budget under half the output limit (`ProviderShared.fitThinkingBudget`),
// and near a full window that limit shrinks with every step, so each step sent another budget. A chat's budget is
// kept instead while it fits, and when it no longer does it is halved, which fits until the room halves again: on a
// 200k window with a 16,000 budget, one change before the chat compacts. It follows from the chat's history, so a
// restart keeps it: the room left by the largest size the provider measured since the chat's latest compaction. That
// size only grows until the next compaction, where the prompt is written anew and the budget is the chat's own again.

/** The least budget Anthropic and Bedrock take. */
const MIN = 1_024
/**
 * Room kept beyond twice the budget. A step whose new messages alone take the room left above that lowers its own
 * budget; the margin makes the next step, which measures those messages, find the room too small as well, so the
 * budget doesn't go back up for a step and down again.
 */
const MARGIN = 4_096
const PROTOCOLS: ReadonlySet<string> = new Set([AnthropicMessages.protocol.id, BedrockConverse.protocol.id])

export interface Chat {
  readonly limit: Model.Info["limit"]
  /** `peak` of the messages before the step whose request this is, or whose request this one continues. */
  readonly peak: number | undefined
  /** That step's output limit before it is fitted to the window. */
  readonly output: number
  /** The share of the window a step leaves unused. */
  readonly headroom: number
}

/**
 * The largest size of the chat the provider of `model` measured since its latest compaction: a step's prompt and its
 * answer, as the next step counts it. Undefined before the first.
 */
export const peak = (messages: ReadonlyArray<SessionMessage.Info>, model: Model.Ref) =>
  messages
    .slice(messages.findLastIndex((message) => message.type === "compaction" && message.status === "completed") + 1)
    .reduce<number | undefined>((most, message) => {
      if (message.type !== "assistant" || message.error || message.tokens === undefined) return most
      if (message.model.providerID !== model.providerID || message.model.id !== model.id) return most
      const tokens = message.tokens
      const size = tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning
      return size > (most ?? 0) ? size : most
    }, undefined)

/**
 * `request` with the chat's thinking budget: the one its route sends far from the window (fitted under the step's
 * output limit before the window fit) while twice it fits both the room `chat.peak` leaves, less the margin, and the
 * request's own output limit; else the first of its halves that does, and never less than the least. The same request
 * when its route sends that budget anyway, as it does everywhere but near the window, and when it asks for no manual
 * budget.
 */
export const keep = (request: LLMRequest, chat: Chat): LLMRequest => {
  const maxTokens = request.maxTokens
  if (maxTokens === undefined || !PROTOCOLS.has(request.model.route.protocol)) return request
  const configured = budget(request)
  if (configured === undefined) return request
  const room =
    chat.peak === undefined || chat.limit.context <= 0
      ? Number.POSITIVE_INFINITY
      : Math.floor(chat.limit.context * (1 - chat.headroom)) - chat.peak
  const kept = halve(ProviderShared.fitThinkingBudget(configured, chat.output, MIN), Math.min(room - MARGIN, maxTokens))
  if (kept === ProviderShared.fitThinkingBudget(configured, maxTokens, MIN)) return request
  const own = request.providerOptions?.thinking
  return {
    ...request,
    providerOptions: {
      ...request.providerOptions,
      thinking: { ...(Predicate.isObject(own) ? own : {}), budgetTokens: kept },
    },
  }
}

const halve = (budget: number, room: number): number =>
  budget <= room / 2 || budget <= MIN ? budget : halve(Math.max(MIN, Math.floor(budget / 2)), room)

const Thinking = Schema.Struct({
  type: Schema.optional(Schema.String),
  budgetTokens: Schema.optional(Schema.Number),
  budget_tokens: Schema.optional(Schema.Number),
})
const decodeThinking = Schema.decodeUnknownOption(Thinking)
const thinking = (options: ProviderOptions | undefined) => Option.getOrUndefined(decodeThinking(options?.thinking))

/** The manual budget `request` asks for: its own thinking option over its model's, read as its route reads them. */
const budget = (request: LLMRequest) => {
  const merged = { ...thinking(request.model.options?.providerOptions), ...thinking(request.providerOptions) }
  if (merged.type !== "enabled") return undefined
  return merged.budgetTokens ?? merged.budget_tokens
}
