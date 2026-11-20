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
// kept instead while it fits. When it no longer does, it becomes, once, the largest budget that still fits at the
// chat's compaction point: on a 200k window that compacts at 172k, 16,000 becomes 10,952 and stays until the chat
// compacts. Without automatic compaction there is no such point, and the budget halves whenever it no longer fits.
// It follows from the chat's history, so a restart keeps it: the room left by the largest size the provider measured
// since the chat's latest compaction. That size only grows until the next compaction, where the prompt is written anew
// and the budget is the chat's own again.

/** The least budget Anthropic and Bedrock take. */
const MIN = 1_024
/**
 * Room kept beyond twice the budget. A step whose new messages alone take the room left above that lowers its own
 * budget; the margin makes the next step, which measures those messages, find the room too small as well, so the
 * budget doesn't go back up for a step and down again. At the compaction point it holds what the output limit sets
 * aside for a step's new messages being estimated low, so the budget fitted there fits every step before it.
 */
const MARGIN = 4_096
const PROTOCOLS: ReadonlySet<string> = new Set([AnthropicMessages.protocol.id, BedrockConverse.protocol.id])

export interface Chat {
  readonly limit: Model.Info["limit"]
  /** `peak` of the messages before the step whose request this is, or whose request this one continues. */
  readonly peak: number | undefined
  /** The prompt size at which the chat compacts automatically; undefined when it doesn't. */
  readonly threshold?: number
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
 * `request` with the chat's thinking budget (`fit`), from the one its route sends far from the window: fitted under the
 * step's output limit before the window fit. The same request when its route sends that budget anyway, as it does
 * everywhere but near the window, and when it asks for no manual budget.
 */
export const keep = (request: LLMRequest, chat: Chat): LLMRequest => {
  const maxTokens = request.maxTokens
  if (maxTokens === undefined || !PROTOCOLS.has(request.model.route.protocol)) return request
  const configured = budget(request)
  if (configured === undefined) return request
  const kept = fit(ProviderShared.fitThinkingBudget(configured, chat.output, MIN), chat, maxTokens)
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

/**
 * The chat's own budget `own` while twice it fits both the room its largest size leaves, less the margin, and the
 * request's output limit; else the largest budget that fits likewise at the chat's compaction point, never more than
 * its own, while that fits; else that budget's halves, and never less than the least.
 */
const fit = (own: number, chat: Chat, maxTokens: number) => {
  const held = Math.min(room(chat, chat.peak) - MARGIN, maxTokens)
  if (own <= held / 2) return own
  const last =
    chat.threshold === undefined
      ? own
      : Math.min(own, Math.max(MIN, Math.floor((room(chat, chat.threshold) - MARGIN) / 2)))
  return halve(last, held)
}

/** The output room a prompt of `size` leaves in the window, as a step's output limit is fitted to it. */
const room = (chat: Chat, size: number | undefined) =>
  size === undefined || chat.limit.context <= 0
    ? Number.POSITIVE_INFINITY
    : Math.floor(chat.limit.context * (1 - chat.headroom)) - size

const halve = (budget: number, held: number): number =>
  budget <= held / 2 || budget <= MIN ? budget : halve(Math.max(MIN, Math.floor(budget / 2)), held)

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
