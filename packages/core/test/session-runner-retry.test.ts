import { describe, expect, test } from "bun:test"
import { AIError, HttpContext, ProviderInternalError, RateLimitError, TransportError } from "@opencode/ai/effect"
import { ModelRetry } from "@opencode/core/model-retry"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Pacer } from "@opencode/schema/pacer"
import { Bus } from "@opencode/core/bus"
import { SessionContinuity } from "@opencode/core/continuity"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Provider } from "@opencode/core/provider"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Clock, Duration, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { it, testEffect } from "./lib/effect"

const timeout = new AIError({
  reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
})
const internal = new AIError({ reason: new ProviderInternalError({ message: "internal" }) })
const dnsFailure = new AIError({
  reason: new TransportError({
    message: "getaddrinfo ENOTFOUND opencode.ai",
    transport: "http",
    operation: "request",
    code: "ENOTFOUND",
    url: "https://opencode.ai/zen/v1/responses",
  }),
})
const refused = new AIError({
  reason: new TransportError({
    message: "Unable to connect",
    transport: "http",
    operation: "request",
    code: "ECONNREFUSED",
  }),
})

const opus = Model.Ref.make({ id: Model.ID.make("claude-opus-5-5"), providerID: Provider.ID.make("cliproxypacer") })

// CPP's answer of 2026-11-14 when every Claude login rested: 503 auth_unavailable with Retry-After 699 s.
const noLogin = new AIError({
  reason: new RateLimitError({
    message:
      "auth_unavailable: no auth available (providers=claude, model=claude-opus-5-5; last upstream error: rate_limit_error: This request would exceed your account's rate limit. Please try again later.)",
    body: JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "auth_unavailable: no auth available (providers=claude, model=claude-opus-5-5)",
      },
    }),
    http: new HttpContext({ url: "https://cpp.example/v1/messages", status: 503, headers: { "retry-after": "699" } }),
    retryAfterMs: 699_000,
  }),
})

const input = (
  cause: AIError,
  model = Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
) => ({
  cause,
  error: toSessionError(cause),
  agent: Agent.ID.make("build"),
  model,
  hook: () => Effect.void,
  retry: SessionRunnerRetry.isRetryable(cause),
})

// Decisions for `count` consecutive failures of the same cause within one step.
const decisions = (cause: AIError, count: number) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
    const results: boolean[] = []
    for (let i = 0; i < count; i++) results.push((yield* policy(input(cause))).retry)
    return results
  })

describe("SessionRunnerRetry.policy", () => {
  it.effect("stops retrying transport timeouts after three attempts", () =>
    Effect.gen(function* () {
      expect(yield* decisions(timeout, 4)).toEqual([true, true, true, false])
    }),
  )

  it.effect("keeps the general allowance for other transient failures", () =>
    Effect.gen(function* () {
      expect(yield* decisions(internal, 11)).toEqual([...Array(10).fill(true), false])
    }),
  )

  it.effect("waits at most a minute for a free login, not the whole Retry-After", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      const decision = yield* policy(input(noLogin, opus))
      expect(decision.retry).toBe(true)
      if (!decision.retry) return
      expect(decision.delay).toBe(SessionRunnerRetry.NO_LOGIN_WAIT)
      expect(decision.login).toEqual(opus)
    }),
  )

  it.effect("does not count the tries for a free login within its Retry-After", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      const results: boolean[] = []
      // Twelve tries a minute apart fit in the 699 s; then the counted retries follow, as for any failure.
      for (let i = 0; i < 12 + 10; i++) {
        const decision = yield* policy(input(noLogin, opus))
        results.push(decision.retry)
        if (decision.retry) yield* TestClock.adjust(decision.delay)
      }
      expect(results).toEqual(Array(22).fill(true))
      expect(policy.progress().noLoginUntil).toBeDefined()
      expect((yield* policy(input(noLogin, opus))).retry).toBe(false)
    }),
  )

  it.effect("keeps the free-login deadline across a restart", () =>
    Effect.gen(function* () {
      const first = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      yield* first(input(noLogin, opus))
      const saved = first.progress()
      yield* TestClock.adjust(120_000)
      const resumed = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"), saved)
      yield* resumed(input(noLogin, opus))
      expect(resumed.progress().noLoginUntil).toBe(saved.noLoginUntil)
      expect(resumed.progress().attempt).toBe(saved.attempt)
    }),
  )

  it.effect("keeps retrying an unreachable host for an hour with gaps of at most 30 seconds", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      const started = yield* Clock.currentTimeMillis
      const delays: number[] = []
      while (true) {
        const decision = yield* policy(input(dnsFailure))
        if (!decision.retry) break
        delays.push(decision.delay)
        yield* TestClock.adjust(Duration.millis(decision.delay))
      }
      const waited = (yield* Clock.currentTimeMillis) - started
      expect(delays.length).toBeGreaterThan(100)
      expect(Math.max(...delays)).toBeLessThanOrEqual(30_000)
      expect(waited).toBeGreaterThanOrEqual(Duration.toMillis(ModelRetry.UNREACHABLE_WINDOW))
      expect(waited).toBeLessThanOrEqual(Duration.toMillis(ModelRetry.UNREACHABLE_WINDOW) + 30_000)
    }),
  )

  it.effect("keeps a refused connection on the general allowance", () =>
    Effect.gen(function* () {
      expect(ModelRetry.isUnreachable(refused)).toBe(false)
      expect(yield* decisions(refused, 11)).toEqual([...Array(10).fill(true), false])
    }),
  )

  it.effect("doesn't spend the general allowance on an unreachable host", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      for (let i = 0; i < 20; i++) expect((yield* policy(input(dnsFailure))).retry).toBe(true)
      const results: boolean[] = []
      for (let i = 0; i < 11; i++) results.push((yield* policy(input(internal))).retry)
      expect(results).toEqual([...Array(10).fill(true), false])
    }),
  )
})

const bus = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node])))
const sessionID = SessionSchema.ID.make("ses_retry_wake")

/** A step's retry waiting for a free login of `opus`, forked; it would sleep the minute out. */
const waiting = (cause = noLogin, model = opus) =>
  Effect.gen(function* () {
    const events = yield* Bus.Service
    const continuity = yield* SessionContinuity.Service.pipe(Effect.provide(SessionContinuity.noopLayer))
    const retry = yield* SessionRunnerRetry.make(events, continuity, sessionID, 1)
    const decision = yield* retry.decide(input(cause, model))
    if (!decision.retry) throw new Error("no retry")
    const fiber = yield* retry
      .wait({ decision, assistantMessageID: SessionMessage.ID.create(), error: toSessionError(cause) })
      .pipe(Effect.forkChild({ startImmediately: true }))
    yield* settle
    return { events, fiber }
  })

const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow
})

describe("SessionRunnerRetry.make", () => {
  bus.effect("ends a wait for a free login on CPP's ready notice for its model", () =>
    Effect.gen(function* () {
      const { events, fiber } = yield* waiting()
      yield* events.publish(Pacer.Event.LoginsReady, { providers: ["codex"], models: ["gpt-5.5"] })
      yield* settle
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* events.publish(Pacer.Event.LoginsReady, { providers: ["claude"], models: ["claude-opus-5-5"] })
      yield* settle
      expect(fiber.pollUnsafe()).toBeDefined()
    }),
  )

  bus.effect("ends a wait for a free login on a ready notice that names no models", () =>
    Effect.gen(function* () {
      const { events, fiber } = yield* waiting()
      yield* events.publish(Pacer.Event.LoginsReady, { providers: ["claude"], models: [] })
      yield* settle
      expect(fiber.pollUnsafe()).toBeDefined()
    }),
  )

  bus.effect("ends any retry wait when a message steers the chat", () =>
    Effect.gen(function* () {
      const { events, fiber } = yield* waiting(internal)
      yield* events.publish(Pacer.Event.LoginsReady, { providers: ["claude"], models: [] })
      yield* settle
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* events.publish(SessionEvent.InboxEnqueued, {
        sessionID: SessionSchema.ID.make("ses_other"),
        inboxID: SessionMessage.ID.create(),
        item: { type: "user", payload: { text: "another chat's" }, delivery: "steer" },
      })
      yield* settle
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* events.publish(SessionEvent.InboxEnqueued, {
        sessionID,
        inboxID: SessionMessage.ID.create(),
        item: { type: "user", payload: { text: "try now" }, delivery: "steer" },
      })
      yield* settle
      expect(fiber.pollUnsafe()).toBeDefined()
      yield* Fiber.join(fiber)
    }),
  )
})

describe("ModelRetry.retryOneShot", () => {
  it.effect("doesn't replay a call whose response was cut off by the network going down", () =>
    Effect.gen(function* () {
      let calls = 0
      const cutOff = new AIError({
        reason: new TransportError({
          message: "Network is down",
          transport: "http",
          operation: "read",
          code: "ENETDOWN",
        }),
      })
      yield* ModelRetry.retryOneShot(Effect.suspend(() => (calls++, Effect.fail(cutOff)))).pipe(Effect.flip)
      expect(calls).toBe(1)
    }),
  )
})

describe("toSessionError", () => {
  test("names the network when the provider's host can't be reached", () => {
    expect(toSessionError(dnsFailure)).toEqual({
      type: "provider.transport",
      message: "Can't reach opencode.ai. Check the network connection. (getaddrinfo ENOTFOUND opencode.ai)",
    })
    expect(toSessionError(refused)).toEqual({ type: "provider.transport", message: "Unable to connect" })
  })
})
