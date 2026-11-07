import { describe, expect, test } from "bun:test"
import { AIError, HttpContext, isRetryable, TransportError } from "@opencode/ai/effect"
import { classifyProviderFailure } from "@opencode/ai/route"
import { PacerAnswers } from "@opencode/core/pacer/answers"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"

const chat = Model.Ref.make({ id: Model.ID.make("claude-test-1"), providerID: Provider.ID.make(PacerEndpoint.id) })

/** An HTTP answer as the route's executor turns it into a failure. */
const answer = (status: number, body: unknown) => {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body)
  return new AIError({
    reason: classifyProviderFailure({
      message: `HTTP ${status}: ${rawBody}`,
      status,
      rawBody,
      http: new HttpContext({ url: "https://cpp.test/v1/messages", status, headers: {} }),
    }),
  })
}

// The body CPP writes for a forced move (pacer_routing.rs, Route::Compact), with made-up account names.
const move = (models: unknown = ["haiku-test", "provb/claude-test-2"]) =>
  answer(409, {
    error: {
      type: "pacer_compact_required",
      reason: "move",
      message: "The pacer moves this chat from a (1) to b (2): compact it first, then continue.",
      models,
    },
  })

// The body CPP writes for a cold chat (pacer_routing.rs, `cold_refusal`), with made-up models.
const cold = (fields: Record<string, unknown> = {}) =>
  answer(409, {
    error: {
      type: "pacer_compact_required",
      reason: "cold",
      message:
        "This chat's prompt cache went cold (14 min idle) and it holds about 152000 tokens: compact it first, then continue.",
      writer: "provider",
      models: ["cheap-test", "haiku-test"],
      size_tokens: 152_000,
      idle_seconds: 840,
      ...fields,
    },
  })

const ids = (ask: PacerAnswers.CompactAsk | undefined) =>
  ask?.models.map((model) => [String(model.providerID), String(model.id)])

describe("PacerAnswers.compactAsk", () => {
  test("reads CPP's ask to compact before a move, with its models on the chat's provider, first first", () => {
    const failure = move()
    // Upstream reads a 409 as a provider failure worth retrying, which would resend without compacting.
    expect(failure.reason._tag).toBe("ProviderInternal")
    expect(isRetryable(failure)).toBe(true)
    expect(PacerAnswers.compactAsk(chat, failure)?.reason).toBe("move")
    expect(ids(PacerAnswers.compactAsk(chat, failure))).toEqual([
      ["cliproxypacer", "haiku-test"],
      ["cliproxypacer", "provb/claude-test-2"],
    ])
  })

  test("tells CPP's ask to compact a cold chat first from a move, whatever writer it names", () => {
    for (const writer of ["provider", "server", "client"]) {
      const ask = PacerAnswers.compactAsk(chat, cold({ writer }))
      expect(ask?.reason).toBe("cold")
      expect(ids(ask)).toEqual([
        ["cliproxypacer", "cheap-test"],
        ["cliproxypacer", "haiku-test"],
      ])
    }
    expect(PacerAnswers.compactAsk(chat, cold({ models: undefined }))).toEqual({ reason: "cold", models: [] })
  })

  test("takes every other reason, or none, as a move, and an answer without models as one with none", () => {
    const unknown = answer(409, { error: { type: "pacer_compact_required", reason: "later", models: ["m-1"] } })
    expect(PacerAnswers.compactAsk(chat, unknown)?.reason).toBe("move")
    expect(ids(PacerAnswers.compactAsk(chat, unknown))).toEqual([["cliproxypacer", "m-1"]])
    const none = answer(409, { error: { type: "pacer_compact_required" } })
    expect(PacerAnswers.compactAsk(chat, none)).toEqual({ reason: "move", models: [] })
    for (const reason of ["Cold", " cold", 7, null, { cold: true }])
      expect(PacerAnswers.compactAsk(chat, cold({ reason }))?.reason).toBe("move")
  })

  test("ignores other answers and other providers", () => {
    const other = Model.Ref.make({ id: Model.ID.make("claude-test-1"), providerID: Provider.ID.make("anthropic") })
    expect(PacerAnswers.compactAsk(other, move())).toBeUndefined()
    expect(PacerAnswers.compactAsk(other, cold())).toBeUndefined()
    expect(PacerAnswers.compactAsk(chat, answer(409, { error: { type: "conflict", message: "busy" } }))).toBeUndefined()
    expect(PacerAnswers.compactAsk(chat, answer(409, "pacer_compact_required"))).toBeUndefined()
    expect(PacerAnswers.compactAsk(chat, move("not a list"))).toBeUndefined()
    const wrongStatus = answer(400, { error: { type: "pacer_compact_required", reason: "move", models: [] } })
    expect(PacerAnswers.compactAsk(chat, wrongStatus)).toBeUndefined()
    expect(PacerAnswers.compactAsk(chat, new Error("409 pacer_compact_required"))).toBeUndefined()
    expect(PacerAnswers.compactAsk(chat, undefined)).toBeUndefined()
  })
})

const other = Model.Ref.make({ id: Model.ID.make("claude-test-1"), providerID: Provider.ID.make("anthropic") })
const cppDown = "CPP is down: the active instance could not be reached from here"
const transport = (fields: { readonly operation: "request" | "read"; readonly code?: string }) =>
  new AIError({ reason: new TransportError({ message: "transport", transport: "http", ...fields }) })

describe("PacerAnswers.badGateway", () => {
  test("is any 502 on the CLIProxyPacer provider", () => {
    expect(
      PacerAnswers.badGateway(
        chat,
        answer(502, { type: "error", error: { type: "overloaded_error", message: cppDown } }),
      ),
    ).toBe(true)
    expect(PacerAnswers.badGateway(chat, answer(502, "error code: 502"))).toBe(true)
    expect(PacerAnswers.badGateway(chat, answer(503, { error: { message: cppDown, code: "cpp_down" } }))).toBe(false)
    expect(PacerAnswers.badGateway(other, answer(502, "error code: 502"))).toBe(false)
  })
})

describe("PacerAnswers.outage", () => {
  test("is a refused or lost connection, a 502 or 504, or CPP's \"CPP is down\" 503, on each route's shape", () => {
    expect(PacerAnswers.outage(chat, transport({ operation: "request", code: "ECONNREFUSED" }))).toBe(true)
    expect(PacerAnswers.outage(chat, transport({ operation: "request" }))).toBe(true)
    expect(PacerAnswers.outage(chat, answer(502, "error code: 502"))).toBe(true)
    expect(PacerAnswers.outage(chat, answer(504, "error code: 504"))).toBe(true)
    // pair_forward.rs's cpp_down on /v1/messages, /v1beta and the OpenAI routes.
    expect(
      PacerAnswers.outage(chat, answer(503, { type: "error", error: { type: "overloaded_error", message: cppDown } })),
    ).toBe(true)
    expect(
      PacerAnswers.outage(chat, answer(503, { error: { code: 503, message: cppDown, status: "UNAVAILABLE" } })),
    ).toBe(true)
    expect(
      PacerAnswers.outage(chat, answer(503, { error: { message: cppDown, type: "server_error", code: "cpp_down" } })),
    ).toBe(true)
  })

  test("is not a timeout, a cut stream, CPP's other 503s, a 429, or another provider's failure", () => {
    expect(PacerAnswers.outage(chat, transport({ operation: "request", code: "Timeout" }))).toBe(false)
    expect(PacerAnswers.outage(chat, transport({ operation: "read", code: "ECONNRESET" }))).toBe(false)
    expect(
      PacerAnswers.outage(
        chat,
        answer(503, { error: { type: "pacer_transient_wait", message: "retry to keep its warm cache" } }),
      ),
    ).toBe(false)
    const unavailable = "auth_unavailable: no auth available (providers=claude, model=claude-test-1)"
    expect(
      PacerAnswers.outage(chat, answer(503, { type: "error", error: { type: "api_error", message: unavailable } })),
    ).toBe(false)
    expect(PacerAnswers.outage(chat, answer(503, { error: { message: `upstream: ${cppDown}` } }))).toBe(false)
    expect(PacerAnswers.outage(chat, answer(429, { error: { code: "model_cooldown", message: "cooling down" } }))).toBe(
      false,
    )
    expect(PacerAnswers.outage(other, answer(502, "error code: 502"))).toBe(false)
    expect(PacerAnswers.outage(other, transport({ operation: "request", code: "ECONNREFUSED" }))).toBe(false)
  })
})
