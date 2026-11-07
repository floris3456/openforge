import { describe, expect } from "bun:test"
import { AIError, ai } from "@opencode/ai/effect"
import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { Cause, Clock, Effect, Layer, Schedule, Schema, Stream, SubscriptionRef } from "effect"
import { Headers, HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerModels } from "@opencode/core/pacer/models"
import { Plugin } from "@opencode/core/plugin"
import type { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { CLIProxyPacerPlugin, isClaude } from "@opencode/core/plugin/provider/cliproxypacer"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { SessionUsage } from "@opencode/core/session/usage"
import { Document, Info } from "@opencode/schema/config"
import { Money } from "@opencode/schema/money"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const decodeConfig = Schema.decodeUnknownSync(Info)
const providerID = Provider.ID.make("cliproxypacer")
const MESSAGES = "@opencode/ai/providers/anthropic-compatible"
const RESPONSES = "@opencode/ai/providers/openai-compatible-responses"
const usd = Money.USDPerMillionTokens.make
const rates = (input: number, output: number, read: number, write: number) => ({
  input: usd(input),
  output: usd(output),
  cache: { read: usd(read), write: usd(write) },
})

// Synthetic: no real address, key, model or price.
const configKey = PacerEndpoint.resolve({ baseURL: "https://cpp.test/proxy", apiKey: "config-key" }, undefined)!
const storedKey = PacerEndpoint.resolve(
  { baseURL: "https://cpp.test/proxy" },
  Credential.Key.make({ type: "key", key: "stored-key" }),
)!

const catalog: PacerModels.Catalog = {
  at: 1,
  pacer: { compactTokens: ["auto", "before-cold", "cold"], webTools: false },
  models: [
    {
      id: "claude-test-1",
      ownedBy: "anthropic",
      name: "Claude Test 1",
      context: 200_000,
      maxOutput: 64_000,
      input: ["text", "image"],
      output: ["text"],
      reasoning: { levels: ["low", "medium", "high"], zeroAllowed: true },
      price: {
        rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        context: [{ above: 200_000, rates: { input: 6, output: 22.5 } }],
      },
    },
    { id: "provb/claude-test-2", ownedBy: "provb" },
    {
      id: "gpt-test-1",
      ownedBy: "openai",
      context: 400_000,
      maxOutput: 128_000,
      input: ["text", "image"],
      output: ["text"],
      reasoning: { levels: ["low", "medium", "high", "xhigh"], zeroAllowed: false },
      price: { rates: { input: 1, output: 8 }, context: [] },
    },
    { id: "plain-1", ownedBy: "provc" },
    { id: "image-1", ownedBy: "provc", output: ["image"] },
  ],
}

/** `address`: whether the config PacerEndpoint reads gives CPP's address. */
const fakeCPP = Effect.fn(function* (
  endpoint: PacerEndpoint.Endpoint | undefined,
  models: PacerModels.Catalog | undefined,
  address = false,
) {
  const endpoints = yield* SubscriptionRef.make(endpoint)
  const catalogs = yield* SubscriptionRef.make(models)
  const addresses = yield* SubscriptionRef.make(address)
  return {
    setEndpoint: (next: PacerEndpoint.Endpoint | undefined) => SubscriptionRef.set(endpoints, next),
    setCatalog: (next: PacerModels.Catalog | undefined) => SubscriptionRef.set(catalogs, next),
    setAddress: (next: boolean) => SubscriptionRef.set(addresses, next),
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(
          PacerEndpoint.Service,
          PacerEndpoint.Service.of({
            get: () => SubscriptionRef.get(endpoints),
            changes: () => SubscriptionRef.changes(endpoints),
            configuredAddress: () => SubscriptionRef.changes(addresses),
          }),
        ),
        Effect.provideService(
          PacerModels.Service,
          PacerModels.Service.of({
            get: () => SubscriptionRef.get(catalogs),
            changes: () => SubscriptionRef.changes(catalogs),
            refresh: () => Effect.void,
          }),
        ),
      ),
  }
})

const addPlugin = Effect.fn(function* (cpp: Effect.Success<ReturnType<typeof fakeCPP>>) {
  const plugin = yield* Plugin.Service
  yield* cpp.provide(CLIProxyPacerPlugin.effect(yield* PluginHost.make(plugin)))
})

/** Config's provider plugin, with these documents as the location's config. */
const addConfig = Effect.fn(function* (...providers: ReadonlyArray<Record<string, unknown>>) {
  const plugin = yield* Plugin.Service
  yield* ConfigProviderPlugin.Plugin.effect(yield* PluginHost.make(plugin)).pipe(
    Effect.provide(
      Config.testLayer(
        providers.map((item) => new Document({ type: "document", info: decodeConfig({ providers: item }) })),
      ),
    ),
  )
})

const listed = Effect.gen(function* () {
  const models = yield* Model.Service
  return (yield* models.available()).filter((model) => model.providerID === providerID)
})

const eventually = <A, R>(effect: Effect.Effect<A, never, R>, predicate: (value: A) => boolean) =>
  effect.pipe(
    Effect.filterOrFail(predicate, () => new Error("Timed out waiting for value")),
    Effect.retry({ times: 3000, schedule: Schedule.spaced("1 millis") }),
  )

/** What a request of this model would carry: its URL, and the auth headers. */
const resolved = Effect.fn(function* (info: Model.Info, credential?: Credential.Value) {
  const model = yield* ModelResolver.fromCatalogModel(info, credential)
  const headers = yield* model.route.auth.apply({
    request: ai.request({ model, prompt: "Hello" }),
    method: "POST",
    url: `${model.route.endpoint.baseURL}/x`,
    body: "{}",
    headers: Headers.empty,
  })
  const header = (name: string): string | undefined => headers[name]
  return {
    baseURL: model.route.endpoint.baseURL,
    authorization: header("authorization"),
    apiKey: header("x-api-key"),
  }
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

describe("CLIProxyPacerPlugin", () => {
  it.effect("connects with a client key whose form asks for CPP's address, and no environment variable", () =>
    Effect.gen(function* () {
      yield* addPlugin(yield* fakeCPP(undefined, undefined))
      const integration = required(yield* (yield* Integration.Service).get(Integration.ID.make("cliproxypacer")))
      expect(integration.name).toBe("CLIProxyPacer")
      expect(integration.methods).toEqual([
        {
          type: "key",
          label: "Client key",
          form: [
            {
              type: "string",
              key: "baseURL",
              title: "CLIProxyPacer address",
              placeholder: "https://cliproxy.example.com",
              required: true,
            },
          ],
        },
      ])
    }),
  )

  it.effect("asks for no address when the config PacerEndpoint reads gives one", () =>
    Effect.gen(function* () {
      yield* addPlugin(yield* fakeCPP(undefined, undefined, true))
      const integration = required(yield* (yield* Integration.Service).get(Integration.ID.make("cliproxypacer")))
      expect(integration.methods).toEqual([{ type: "key", label: "Client key" }])
    }),
  )

  it.effect("asks for the address when only a project's config gives one, which PacerEndpoint never reads", () =>
    Effect.gen(function* () {
      yield* addPlugin(yield* fakeCPP(undefined, undefined, false)).pipe(
        Effect.provide(
          Config.testLayer([
            new Document({
              type: "document",
              info: decodeConfig({ providers: { cliproxypacer: { settings: { baseURL: "https://project.test" } } } }),
            }),
          ]),
        ),
      )
      const integration = required(yield* (yield* Integration.Service).get(Integration.ID.make("cliproxypacer")))
      expect(
        integration.methods.map((method) => method.type === "key" && method.form?.map((field) => field.key)),
      ).toEqual([["baseURL"]])
    }),
  )

  it.live("asks for the address again when config stops giving one, and not once it gives one", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCPP(undefined, undefined, false)
      yield* addPlugin(cpp)
      const integrations = yield* Integration.Service
      const asks = integrations
        .get(Integration.ID.make("cliproxypacer"))
        .pipe(Effect.map((integration) => integration?.methods.some((method) => method.type === "key" && method.form)))
      expect(yield* asks).toBe(true)
      yield* cpp.setAddress(true)
      yield* eventually(asks, (value) => value === false)
      yield* cpp.setAddress(false)
      yield* eventually(asks, (value) => value === true)
    }),
  )

  it.effect("offers nothing while CPP is not set up", () =>
    Effect.gen(function* () {
      yield* addPlugin(yield* fakeCPP(undefined, catalog))
      expect(yield* listed).toEqual([])
      const providers = yield* Provider.Service
      expect(required(yield* providers.get(providerID)).activation).toBe("auto")
    }),
  )

  it.effect("lists CPP's models: Claude on Messages, the rest on Responses, with CPP's limits and prices", () =>
    Effect.gen(function* () {
      yield* addPlugin(yield* fakeCPP(configKey, catalog))
      const models = yield* listed
      expect(models.map((model) => [String(model.id), model.package, model.name])).toEqual([
        ["claude-test-1", MESSAGES, "Claude Test 1"],
        ["provb/claude-test-2", MESSAGES, "provb/claude-test-2"],
        ["gpt-test-1", RESPONSES, "gpt-test-1"],
        ["plain-1", RESPONSES, "plain-1"],
      ])
      const [claude, , gpt, plain] = models
      expect(required(claude).limit).toEqual({ context: 200_000, output: 64_000 })
      expect(required(claude).capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] })
      expect(required(claude).cost).toEqual([
        rates(3, 15, 0.3, 3.75),
        // A tier sets what changes; the rest is the base price, as CPP lays it.
        { tier: { type: "context", size: 200_000 }, ...rates(6, 22.5, 0.3, 3.75) },
      ])
      expect(required(claude).variants.map((variant) => String(variant.id))).toEqual(["none", "low", "medium", "high"])
      expect(required(gpt).variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high", "xhigh"])
      expect(required(gpt).variants[0]?.settings).toMatchObject({ reasoningEffort: "low" })
      // Nothing known: openforge's defaults, no limits, no price.
      expect(required(plain).limit).toEqual({ context: 0, output: 0 })
      expect(required(plain).capabilities).toEqual(Model.Capabilities.default())
      expect(required(plain).cost).toEqual([])
      expect(required(plain).variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high"])
    }),
  )

  it.effect("leaves a model unpriced, not free, unless CPP gives both its input and its output rate", () =>
    Effect.gen(function* () {
      yield* addPlugin(
        yield* fakeCPP(configKey, {
          at: 1,
          pacer: null,
          models: [
            { id: "none-1", ownedBy: "provc" },
            { id: "input-1", ownedBy: "provc", price: { rates: { input: 2 }, context: [] } },
            { id: "output-1", ownedBy: "provc", price: { rates: { output: 8 }, context: [] } },
            { id: "both-1", ownedBy: "provc", price: { rates: { input: 2, output: 8 }, context: [] } },
          ],
        }),
      )
      // No rows is openforge's unknown price; one all-zero row would be a free model.
      expect((yield* listed).map((model) => [String(model.id), model.cost])).toEqual([
        ["none-1", []],
        ["input-1", []],
        ["output-1", []],
        ["both-1", [rates(2, 8, 0, 0)]],
      ])
    }),
  )

  it.effect("tells Claude apart by owner or by the last segment of its ID", () =>
    Effect.sync(() => {
      expect(isClaude({ id: "claude-x" })).toBe(true)
      expect(isClaude({ id: "vendor/Claude-x" })).toBe(true)
      expect(isClaude({ id: "opus-x", ownedBy: "Anthropic" })).toBe(true)
      expect(isClaude({ id: "claude/x" })).toBe(false)
      expect(isClaude({ id: "gpt-x", ownedBy: "openai" })).toBe(false)
    }),
  )

  it.effect("sends config's key as a bearer token to CPP's address on both packages", () =>
    Effect.gen(function* () {
      yield* addPlugin(yield* fakeCPP(configKey, catalog))
      // A project's config can name another address and key; CPP's stay.
      yield* addConfig({
        cliproxypacer: { settings: { baseURL: "https://project.test/v1", apiKey: "project-key" } },
      })
      const models = yield* listed
      expect(models.map((model) => String(model.id))).toEqual([
        "claude-test-1",
        "provb/claude-test-2",
        "gpt-test-1",
        "plain-1",
      ])
      for (const model of models)
        expect(yield* resolved(model)).toEqual({
          baseURL: "https://cpp.test/proxy/v1",
          authorization: "Bearer config-key",
          apiKey: undefined,
        })
    }),
  )

  it.effect("keeps a stored key out of model settings, and sends it as a bearer token", () =>
    Effect.gen(function* () {
      yield* addPlugin(yield* fakeCPP(storedKey, catalog))
      yield* addConfig({ cliproxypacer: { settings: { baseURL: "https://project.test", apiKey: "project-key" } } })
      const credential = Credential.Key.make({ type: "key", key: "stored-key" })
      for (const model of yield* listed) {
        expect(JSON.stringify(model)).not.toContain("stored-key")
        expect(yield* resolved(model, credential)).toEqual({
          baseURL: "https://cpp.test/proxy/v1",
          authorization: "Bearer stored-key",
          apiKey: undefined,
        })
      }
    }),
  )

  it.live("follows CPP's address and catalog", () =>
    Effect.gen(function* () {
      const cpp = yield* fakeCPP(configKey, catalog)
      yield* addPlugin(cpp)
      expect((yield* listed).length).toBe(4)
      yield* cpp.setCatalog({ at: 2, pacer: null, models: [{ id: "other-1", ownedBy: "provc" }] })
      yield* eventually(listed, (models) => models.map((model) => String(model.id)).join() === "other-1")
      yield* cpp.setEndpoint(undefined)
      yield* eventually(listed, (models) => models.length === 0)
    }),
  )
})

/** CPP's answer, as its source writes it (`pacer_routing.rs`, `dispatch.rs`, `pair_forward.rs`). */
const answer =
  (status: number, body: string, headers: Record<string, string> = {}) =>
  () =>
    new Response(body, { status, headers: { "content-type": "application/json", ...headers } })
const sse =
  (...events: ReadonlyArray<readonly [string, unknown]>) =>
  () =>
    new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })
const cppDown = "CPP is down: the active cannot be reached"
const cppDownMessages = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: cppDown } })
const cppDownResponses = JSON.stringify({ error: { message: cppDown, type: "server_error", code: "cpp_down" } })
const transientWait = JSON.stringify({
  error: {
    type: "pacer_transient_wait",
    message: "Pacer: this chat's account failed briefly; retry to keep its warm cache",
  },
})
const modelCooldown = answer(
  429,
  JSON.stringify({
    error: {
      code: "model_cooldown",
      message: "All credentials for model claude-test-1 are cooling down via provider claude",
      model: "claude-test-1",
      provider: "claude",
      reset_seconds: 60,
      reset_time: "1m0s",
    },
  }),
  { "retry-after": "60" },
)
// dispatch.rs's `unavailable_text`, which errors.rs wraps as each route's error.
const authUnavailable = "auth_unavailable: no auth available (providers=claude, model=claude-test-1)"
const streamCut = "this server stopped serving this stream (a restart, an update or a switch over); retry the request"
const messagesStart = [
  [
    "message_start",
    {
      type: "message_start",
      message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test-1", content: [], usage: {} },
    },
  ],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }],
] as const
const responsesStart = [
  [
    "response.created",
    { type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress" } },
  ],
  [
    "response.output_text.delta",
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hel" },
  ],
] as const

/** Sends a request of the CPP model through its route to `http`, and returns the model's ref and how the stream failed. */
const failed = Effect.fn(function* (id: string, http: HttpClient.HttpClient) {
  yield* addPlugin(yield* fakeCPP(configKey, catalog))
  const info = required((yield* listed).find((model) => String(model.id) === id))
  const model = yield* ModelResolver.fromCatalogModel(info)
  const failure = yield* LLMClient.stream(ai.request({ model, prompt: "Hello" })).pipe(
    Stream.runDrain,
    Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.fresh)),
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.flip,
  )
  if (!(failure instanceof AIError)) return yield* Effect.die(failure)
  return { model: Model.Ref.make({ id: info.id, providerID }), failure }
})

const answering = (reply: () => Response) =>
  HttpClient.make((request) => Effect.sync(() => HttpClientResponse.fromWeb(request, reply())))

/** An HTTP client whose every request fails as fetch's does when the cause is `cause`. */
const failing = (cause: unknown) =>
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, cause }) }),
    ),
  )

/**
 * The decisions upstream's retry policy makes, as a step consults it, on `failures` one after another, and when each
 * was made, from the first. With `wait` the test clock moves by each wait decided, as the step waits it, and the
 * decisions end at the first that does not retry. `from` is the progress a restarted step continues from, and `hook`
 * a plugin's `session.retry` hook.
 */
const decided = Effect.fn(function* (
  model: Model.Ref,
  failures: ReadonlyArray<AIError>,
  options: {
    readonly wait?: boolean
    readonly from?: SessionRunnerRetry.Progress
    readonly hook?: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  } = {},
) {
  const decide = yield* SessionRunnerRetry.policy(Session.ID.make("ses_cpp_answers"), options.from)
  const begun = yield* Clock.currentTimeMillis
  const decisions = []
  const times = []
  for (const failure of failures) {
    const decision = yield* decide({
      cause: failure,
      error: toSessionError(failure),
      agent: Agent.defaultID,
      model,
      hook: options.hook ?? (() => Effect.void),
      retry: SessionRunnerRetry.isRetryable(failure),
    })
    decisions.push(decision)
    times.push((yield* Clock.currentTimeMillis) - begun)
    if (!options.wait) continue
    if (!decision.retry) break
    yield* TestClock.adjust(decision.delay)
  }
  return { decisions, times, progress: decide.progress() }
})

/**
 * Sends a request of the CPP model through its route to an HTTP client that answers `reply`, and returns how the
 * stream failed, then the decisions upstream's retry policy makes on that failure, as a step consults it, over
 * `attempts` attempts in a row.
 */
const answered = Effect.fn(function* (id: string, reply: () => Response, attempts = 1) {
  const { model, failure } = yield* failed(id, answering(reply))
  const { decisions } = yield* decided(model, Array(attempts).fill(failure))
  return { failure, error: toSessionError(failure), decisions }
})

/** `count` retries in a row, from the second attempt on, each waiting `delay` ms, then none. */
const retries = (count: number, delay: number, from = 2) => [
  ...Array.from({ length: count }, (_, index) => ({ retry: true as const, attempt: from + index, delay })),
  { retry: false as const },
]

const MINUTES_30 = 30 * 60_000

/** The delays a retry would wait, in seconds; undefined where the policy does not retry. */
const delays = (decisions: ReadonlyArray<{ readonly retry: boolean; readonly delay?: number }>) =>
  decisions.map((decision) => (decision.retry ? (decision.delay ?? 0) / 1000 : undefined))

describe("CLIProxyPacer's answers (spec, section 2)", () => {
  // The first retry is the second attempt.
  it.effect("503 pacer_transient_wait: waits its Retry-After, then tries again", () =>
    Effect.gen(function* () {
      const { decisions } = yield* answered(
        "claude-test-1",
        answer(
          503,
          JSON.stringify({
            error: {
              type: "pacer_transient_wait",
              message: "Pacer: this chat's account failed briefly; retry to keep its warm cache",
            },
          }),
          { "retry-after": "2" },
        ),
      )
      // The schedule's own first gap is 2 s with jitter, so the wait is at least the 2 s asked for.
      expect(decisions).toMatchObject([{ retry: true, attempt: 2 }])
      expect(delays(decisions)[0]).toBeGreaterThanOrEqual(2)
      expect(delays(decisions)[0]).toBeLessThanOrEqual(2.4)
    }),
  )

  it.effect("429 model_cooldown: waits its Retry-After, then tries again", () =>
    Effect.gen(function* () {
      const { decisions } = yield* answered(
        "claude-test-1",
        answer(
          429,
          JSON.stringify({
            error: {
              code: "model_cooldown",
              message: "All credentials for model claude-test-1 are cooling down via provider claude",
              model: "claude-test-1",
              provider: "claude",
              reset_seconds: 60,
              reset_time: "1m0s",
            },
          }),
          { "retry-after": "60" },
        ),
      )
      expect(decisions).toEqual([{ retry: true, attempt: 2, delay: 60_000 }])
    }),
  )

  it.effect("503 CPP is down: waits its Retry-After of 30 s, then tries again, on Messages and on Responses", () =>
    Effect.gen(function* () {
      const messages = yield* answered(
        "claude-test-1",
        answer(503, JSON.stringify({ type: "error", error: { type: "overloaded_error", message: cppDown } }), {
          "retry-after": "30",
        }),
      )
      expect(messages.decisions).toEqual([{ retry: true, attempt: 2, delay: 30_000 }])
      const responses = yield* answered(
        "gpt-test-1",
        answer(503, JSON.stringify({ error: { message: cppDown, type: "server_error", code: "cpp_down" } }), {
          "retry-after": "30",
        }),
      )
      expect(responses.decisions).toEqual([{ retry: true, attempt: 2, delay: 30_000 }])
    }),
  )

  it.effect("502: upstream's schedule, 2, 4, 8, then every 10 s (with up to 20% jitter)", () =>
    Effect.gen(function* () {
      const { decisions } = yield* answered(
        "claude-test-1",
        answer(502, JSON.stringify({ type: "error", error: { type: "api_error", message: "Bad gateway" } })),
        6,
      )
      const waited = delays(decisions)
      for (const [index, base] of [2, 4, 8, 10, 10, 10].entries()) {
        expect(waited[index]).toBeGreaterThanOrEqual(base * 0.8)
        expect(waited[index]).toBeLessThanOrEqual(base * 1.2)
      }
    }),
  )

  it.effect(
    "502 of a pair's failed forward: tried again after the schedule's own gap, not its Retry-After of 30 s; a second 502 in a row waits it",
    () =>
      Effect.gen(function* () {
        // pair_forward.rs's bad_gateway is cpp_down's answer with the status changed, so it keeps Retry-After: 30. The
        // standby then stops its connector, and Cloudflare sends the next request to the other instance at once.
        const { decisions } = yield* answered("claude-test-1", answer(502, cppDownMessages, { "retry-after": "30" }), 3)
        expect(decisions).toMatchObject([
          { retry: true, attempt: 2 },
          { retry: true, attempt: 3, delay: 30_000 },
          { retry: true, attempt: 4, delay: 30_000 },
        ])
        // The schedule's first gap: 2 s with up to 20% jitter.
        expect(delays(decisions)[0]).toBeGreaterThanOrEqual(1.6)
        expect(delays(decisions)[0]).toBeLessThanOrEqual(2.4)
      }),
  )

  it.effect("a failure other than a 502 ends a run of them: the next 502 is tried again after the schedule's gap", () =>
    Effect.gen(function* () {
      const forward = yield* failed("claude-test-1", answering(answer(502, cppDownMessages, { "retry-after": "30" })))
      const transient = yield* failed("claude-test-1", answering(answer(503, transientWait, { "retry-after": "2" })))
      const waited = delays(
        (yield* decided(forward.model, [forward.failure, transient.failure, forward.failure, forward.failure]))
          .decisions,
      )
      // The schedule's gaps, 2, 4 and 8 s with up to 20% jitter; only the second 502 in a row waits its 30 s.
      for (const [index, base] of [2, 4, 8].entries()) {
        expect(waited[index]).toBeGreaterThanOrEqual(base * 0.8)
        expect(waited[index]).toBeLessThanOrEqual(base * 1.2)
      }
      expect(waited[3]).toBe(30)
    }),
  )

  it.effect(
    "503 CPP is down: keeps retrying past upstream's 10 retries, each after its Retry-After of 30 s, until 30 minutes from the first, on Messages and on Responses",
    () =>
      Effect.gen(function* () {
        for (const [id, body] of [
          ["claude-test-1", cppDownMessages],
          ["gpt-test-1", cppDownResponses],
        ] as const) {
          const { model, failure } = yield* failed(id, answering(answer(503, body, { "retry-after": "30" })))
          const { decisions, times } = yield* decided(model, Array(100).fill(failure), { wait: true })
          // Tried at 0, 30 s, …, 29 min 30 s from the first failure; at 30 minutes, no more.
          expect(decisions).toEqual(retries(60, 30_000))
          expect(times.at(-1)).toBe(MINUTES_30)
        }
      }),
  )

  it.effect(
    "a refused connection: keeps retrying past upstream's 10 retries, every 10 s with up to 20% jitter, until 30 minutes from the first",
    () =>
      Effect.gen(function* () {
        const { model, failure } = yield* failed(
          "claude-test-1",
          failing(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" })),
        )
        expect(failure.reason).toMatchObject({ _tag: "Transport", operation: "request", code: "ECONNREFUSED" })
        const { decisions, times } = yield* decided(model, Array(400).fill(failure), { wait: true })
        expect(decisions.at(-1)).toEqual({ retry: false })
        expect(times.at(-2)).toBeLessThan(MINUTES_30)
        expect(times.at(-1)).toBeGreaterThanOrEqual(MINUTES_30)
        // Every decision before it retried; past upstream's 10, after 8 to 12 s.
        expect(decisions.slice(0, -1).every((decision) => decision.retry)).toBe(true)
        expect(decisions.length).toBeGreaterThan(100)
        for (const waited of delays(decisions.slice(10, -1))) {
          expect(waited).toBeGreaterThanOrEqual(8)
          expect(waited).toBeLessThanOrEqual(12)
        }
      }),
  )

  it.effect(
    "429 model_cooldown, 503 pacer_transient_wait and 503 auth_unavailable are no outage: upstream's 10 retries; a timeout its 3",
    () =>
      Effect.gen(function* () {
        const cooldown = yield* failed("claude-test-1", answering(modelCooldown))
        const transient = yield* failed("claude-test-1", answering(answer(503, transientWait, { "retry-after": "2" })))
        const unavailable = [
          yield* failed(
            "claude-test-1",
            answering(
              answer(503, JSON.stringify({ type: "error", error: { type: "api_error", message: authUnavailable } })),
            ),
          ),
          yield* failed(
            "gpt-test-1",
            answering(
              answer(
                503,
                JSON.stringify({
                  error: { message: authUnavailable, type: "server_error", code: "internal_server_error" },
                }),
              ),
            ),
          ),
        ]
        expect((yield* decided(cooldown.model, Array(20).fill(cooldown.failure), { wait: true })).decisions).toEqual(
          retries(10, 60_000),
        )
        for (const { model, failure } of [transient, ...unavailable]) {
          const { decisions } = yield* decided(model, Array(20).fill(failure), { wait: true })
          expect(decisions).toHaveLength(11)
          expect(decisions.at(-1)).toEqual({ retry: false })
        }
        const timeout = yield* failed("claude-test-1", failing(new Cause.TimeoutError("timed out")))
        expect(timeout.failure.reason).toMatchObject({ _tag: "Transport", code: "Timeout" })
        expect(
          (yield* decided(timeout.model, Array(20).fill(timeout.failure), { wait: true })).decisions.map(
            (decision) => decision.retry,
          ),
        ).toEqual([true, true, true, false])
      }),
  )

  it.effect("a 502 upstream would not retry is no outage, even when a plugin retries it: upstream's 10 retries", () =>
    Effect.gen(function* () {
      const { model, failure } = yield* failed(
        "claude-test-1",
        answering(answer(502, cppDownMessages, { "x-should-retry": "false" })),
      )
      expect(SessionRunnerRetry.isRetryable(failure)).toBe(false)
      const retried = (event: PluginHooks.Domains["session"]["retry"]) =>
        Effect.sync(() => {
          event.decision = { retry: true, delay: 10_000 }
        })
      const { decisions } = yield* decided(model, Array(20).fill(failure), { wait: true, hook: retried })
      expect(decisions).toEqual(retries(10, 10_000))
    }),
  )

  it.effect("another provider's 502 and 503 with CPP's answers: upstream's 10 retries, each after the 30 s", () =>
    Effect.gen(function* () {
      for (const [status, body] of [
        [502, cppDownMessages],
        [503, cppDownMessages],
      ] as const) {
        const { model, failure } = yield* failed(
          "claude-test-1",
          answering(answer(status, body, { "retry-after": "30" })),
        )
        const other = Model.Ref.make({ id: model.id, providerID: Provider.ID.make("other") })
        expect((yield* decided(other, Array(20).fill(failure), { wait: true })).decisions).toEqual(retries(10, 30_000))
      }
    }),
  )

  it.effect("a failure that is no outage ends a run of them: the 30 minutes count from the next outage", () =>
    Effect.gen(function* () {
      const down = yield* failed("gpt-test-1", answering(answer(503, cppDownResponses, { "retry-after": "30" })))
      const cooldown = yield* failed("gpt-test-1", answering(modelCooldown))
      const { decisions, times } = yield* decided(
        down.model,
        [...Array(5).fill(down.failure), cooldown.failure, ...Array(100).fill(down.failure)],
        { wait: true },
      )
      // Down at 0 to 120 s, the cooldown at 150 s waits 60 s, and the next run of outages begins at 210 s.
      expect(times.slice(0, 7)).toEqual([0, 30_000, 60_000, 90_000, 120_000, 150_000, 210_000])
      expect(decisions.at(-1)).toEqual({ retry: false })
      expect(times.at(-1)).toBe(210_000 + MINUTES_30)
    }),
  )

  it.effect(
    "a restarted step keeps its run of outages: it stops 30 minutes from the first failure, not from the restart",
    () =>
      Effect.gen(function* () {
        const { model, failure } = yield* failed(
          "gpt-test-1",
          answering(answer(503, cppDownResponses, { "retry-after": "30" })),
        )
        const begun = yield* Clock.currentTimeMillis
        const before = yield* decided(model, Array(20).fill(failure), { wait: true })
        // What the step's rest stores: 20 failures, 30 s apart, of a run that began with the first.
        expect(before.progress).toEqual({ attempt: 21, timeouts: 0, outageSince: begun })
        // The service is down for 15 minutes; the step's policy is rebuilt from its rest, 25 minutes into the run.
        yield* TestClock.adjust("15 minutes")
        const after = yield* decided(model, Array(100).fill(failure), { wait: true, from: before.progress })
        expect(after.decisions).toEqual(retries(10, 30_000, 22))
        expect((yield* Clock.currentTimeMillis) - begun).toBe(MINUTES_30)
      }),
  )

  it.effect("a stream without its end event fails, then the retry tries again, on Messages and on Responses", () =>
    Effect.gen(function* () {
      for (const [id, reply] of [
        ["claude-test-1", sse(...messagesStart)],
        ["gpt-test-1", sse(...responsesStart)],
      ] as const) {
        const { failure, decisions } = yield* answered(id, reply)
        expect(failure.reason._tag).toBe("InvalidProviderOutput")
        expect(decisions).toMatchObject([{ retry: true, attempt: 2 }])
      }
    }),
  )

  it.effect("a stream CPP cuts with its error event fails, then the retry tries again", () =>
    Effect.gen(function* () {
      const messages = yield* answered(
        "claude-test-1",
        sse(...messagesStart, ["error", { type: "error", error: { type: "api_error", message: streamCut } }]),
      )
      expect(messages.decisions).toMatchObject([{ retry: true, attempt: 2 }])
      const responses = yield* answered(
        "gpt-test-1",
        sse(...responsesStart, [
          "error",
          {
            type: "error",
            error: { type: "server_error", code: "internal_server_error", message: streamCut, param: null },
            sequence_number: 3,
          },
        ]),
      )
      expect(responses.decisions).toMatchObject([{ retry: true, attempt: 2 }])
    }),
  )

  it.effect("400 secret_redaction_failed: shows CPP's message, with no retry, on Messages and on Responses", () =>
    Effect.gen(function* () {
      const message = "secret redaction: a typed part has two type keys; the request was not sent"
      const messages = yield* answered(
        "claude-test-1",
        answer(400, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } })),
      )
      expect(messages.decisions).toEqual([{ retry: false }])
      expect(messages.error.message).toContain(message)
      const responses = yield* answered(
        "gpt-test-1",
        answer(
          400,
          JSON.stringify({ error: { message, type: "invalid_request_error", code: "secret_redaction_failed" } }),
        ),
      )
      expect(responses.decisions).toEqual([{ retry: false }])
      expect(responses.error.message).toContain(message)
    }),
  )
})

describe("CLIProxyPacer's unpriced models", () => {
  it.effect("answer a turn, whose step records its tokens at a cost of 0, on Messages and on Responses", () =>
    Effect.gen(function* () {
      yield* addPlugin(yield* fakeCPP(configKey, catalog))
      const models = yield* listed
      for (const [id, reply, tokens] of [
        [
          "provb/claude-test-2",
          sse(
            [
              "message_start",
              {
                type: "message_start",
                message: {
                  id: "msg_1",
                  type: "message",
                  role: "assistant",
                  model: "provb/claude-test-2",
                  content: [],
                  usage: { input_tokens: 12, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
                },
              },
            ],
            ...messagesStart.slice(1),
            [
              "content_block_delta",
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
            ],
            ["content_block_stop", { type: "content_block_stop", index: 0 }],
            [
              "message_delta",
              { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
            ],
            ["message_stop", { type: "message_stop" }],
          ),
          { input: 12, output: 5, reasoning: 0, cache: { read: 100, write: 20 } },
        ],
        [
          "plain-1",
          sse(
            responsesStart[0],
            [
              "response.output_item.added",
              { type: "response.output_item.added", item: { type: "message", id: "msg_1" } },
            ],
            responsesStart[1],
            [
              "response.output_text.delta",
              { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "lo" },
            ],
            [
              "response.output_item.done",
              {
                type: "response.output_item.done",
                item: {
                  type: "message",
                  id: "msg_1",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "Hello", annotations: [] }],
                },
              },
            ],
            [
              "response.completed",
              {
                type: "response.completed",
                response: {
                  id: "resp_1",
                  object: "response",
                  status: "completed",
                  output: [],
                  usage: {
                    input_tokens: 132,
                    input_tokens_details: { cached_tokens: 100 },
                    output_tokens: 5,
                    output_tokens_details: { reasoning_tokens: 2 },
                  },
                },
              },
            ],
          ),
          { input: 32, output: 3, reasoning: 2, cache: { read: 100, write: 0 } },
        ],
      ] as const) {
        const info = required(models.find((model) => String(model.id) === id))
        expect(info.cost).toEqual([])
        const http = HttpClient.make((request) => Effect.sync(() => HttpClientResponse.fromWeb(request, reply())))
        const response = yield* LLMClient.generate(
          ai.request({ model: yield* ModelResolver.fromCatalogModel(info), prompt: "Hello" }),
        ).pipe(
          Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.fresh)),
          Effect.provideService(HttpClient.HttpClient, http),
        )
        expect(response.text).toBe("Hello")
        // A step records its answer's usage with the model's cost (step.ts), which the runner takes from the catalog.
        expect(SessionUsage.record(response.usage, info.cost)).toEqual({ tokens, cost: Money.USD.zero })
      }
    }),
  )
})
