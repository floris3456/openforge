import { describe, expect } from "bun:test"
import { Context, Effect, Fiber, Layer, Option, Stream, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { testEffect } from "../lib/effect"

// Synthetic answers in the shapes CPP gives; no real model, account or price.
const listed = {
  object: "list",
  data: [
    { id: "claude-test-1", object: "model", owned_by: "anthropic" },
    { id: "provb/claude-test-1", object: "model", owned_by: "anthropic" },
    { id: "vendor/slashed-1", object: "model", owned_by: "provc" },
    {
      id: "custom-1",
      object: "model",
      owned_by: "provc",
      display_name: "Custom One",
      context_length: 50_000,
      max_completion_tokens: 4_000,
    },
    { id: "manual-1", object: "model", owned_by: "provc" },
    { id: "claude-test-1", object: "model", owned_by: "anthropic" },
    { id: 7, object: "model" },
  ],
}

const capabilities = {
  pacer: { compact_tokens: ["auto", "before-cold", "cold"], warming: { compact_before_cold: false } },
  providers: [],
  models: [
    {
      id: "claude-test-1",
      display_name: "Claude Test 1",
      remote_compaction: "mixed",
      routes: [
        {
          provider: "prova",
          context_length: 200_000,
          max_output: 64_000,
          input: ["text", "image"],
          output: ["text"],
          reasoning: { levels: ["low", "medium", "high"], zero_allowed: true },
        },
        {
          provider: "provb",
          context_length: 100_000,
          max_output: 32_000,
          input: ["Text"],
          output: ["text"],
          reasoning: { levels: ["medium", "high"], min: 1_024, max: 32_000, zero_allowed: false },
        },
        { provider: 5 },
      ],
    },
    {
      id: "vendor/slashed-1",
      display_name: "Slashed",
      routes: [
        { provider: "provc", context_length: 128_000, max_output: null, input: ["text"], output: ["text", "image"] },
      ],
    },
    { id: "image-1", routes: [{ provider: "provc", output: ["image"] }] },
    "not a model",
  ],
}

const rates = (input: number) => ({ input, output: input * 5, cache_read: input / 10, cache_write: input * 1.25 })
const prices = {
  catalog: { etag: "e1", synced_at: 1, models: 3 },
  manual: [{ model: "Manual-1", input: 1, output: 2 }],
  models: [
    {
      provider: "provb",
      model: "claude-test-1",
      requests: 3,
      price: { rates: { ...rates(2), cache_write: null }, context: null, fast: null, source: {} },
    },
    {
      provider: "prova",
      model: "claude-test-1",
      requests: 9,
      price: {
        rates: rates(3),
        context: [
          { above: 400_000, rates: rates(9) },
          { above: 200_000, rates: rates(6) },
        ],
        fast: rates(12),
        source: {},
      },
    },
    { provider: "provc", model: "vendor/slashed-1", requests: 1, price: null },
  ],
  report: {},
  settings: [{ provider: "provc", model: "manual-1", display_name: "Named By Setting", max_output: 8_000 }],
}

type Answers = Record<string, () => Response | Promise<Response>>

const cpp = (): Answers => ({
  "/v1/models": () => Response.json(listed),
  "/pacer/v1/capabilities": () => Response.json(capabilities),
  "/pacer/v1/models": () => Response.json(prices),
})

/** A local server that answers by path from `answers`, which a test may change, and counts what it gets. */
const serve = (answers: Answers) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const seen: string[] = []
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          const path = new URL(request.url).pathname
          seen.push(path)
          return answers[path]?.() ?? new Response("404 page not found", { status: 404 })
        },
      })
      return { seen, answers, origin: `http://127.0.0.1:${server.port}`, server }
    }),
    (served) => Effect.promise(() => served.server.stop(true)),
  )

const endpoint = (origin: string, key = "test-key") =>
  PacerEndpoint.resolve({ baseURL: `${origin}/v1`, apiKey: key }, undefined)

/** PacerModels over the real PacerHttp, with an endpoint the test sets. */
const start = (initial: PacerEndpoint.Endpoint | undefined) =>
  Effect.gen(function* () {
    const current = yield* SubscriptionRef.make(initial)
    const endpoints = Layer.succeed(
      PacerEndpoint.Service,
      PacerEndpoint.Service.of({
        get: () => SubscriptionRef.get(current),
        changes: () => SubscriptionRef.changes(current),
      }),
    )
    const context = yield* Layer.build(
      PacerModels.layer.pipe(
        Layer.provide(PacerHttp.layer),
        Layer.provide(endpoints),
        Layer.provide(FetchHttpClient.layer),
      ),
    )
    const models = Context.get(context, PacerModels.Service)
    return {
      models,
      set: (next: PacerEndpoint.Endpoint | undefined) => SubscriptionRef.set(current, next),
    }
  })

/** The first catalog that satisfies `check`. */
const until = (models: PacerModels.Interface, check: (catalog: PacerModels.Catalog | undefined) => boolean) =>
  models
    .changes()
    .pipe(Stream.filter(check), Stream.runHead, Effect.map(Option.getOrThrow), Effect.timeout("3 seconds"))

const loaded = (catalog: PacerModels.Catalog | undefined) => catalog !== undefined

/** Waits until `check` holds, for what no catalog change announces. */
const eventually = (check: () => boolean) =>
  Effect.gen(function* () {
    while (!check()) yield* Effect.sleep("10 millis")
  }).pipe(Effect.timeout("3 seconds"))

const it = testEffect(Layer.empty)

describe("PacerModels", () => {
  it.live("builds the catalog from the model list, capabilities and prices", () =>
    Effect.gen(function* () {
      const server = yield* serve(cpp())
      const { models } = yield* start(endpoint(server.origin))
      const catalog = yield* until(models, loaded)
      expect(catalog?.pacer).toEqual({ compactTokens: ["auto", "before-cold", "cold"] })
      expect(catalog?.models).toEqual([
        {
          id: "claude-test-1",
          ownedBy: "anthropic",
          name: "Claude Test 1",
          // The smallest limits, the input every route takes, thinking every route accepts.
          context: 100_000,
          maxOutput: 32_000,
          input: ["text"],
          output: ["text"],
          reasoning: { levels: ["medium", "high"], min: 1_024, max: 32_000, zeroAllowed: false },
          // Priced as its first route's provider, the context tiers in ascending order.
          price: {
            rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            context: [
              { above: 200_000, rates: { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 } },
              { above: 400_000, rates: { input: 9, output: 45, cacheRead: 0.9, cacheWrite: 11.25 } },
            ],
          },
        },
        {
          // Not in capabilities: the base model's routes of the provider the ID names.
          id: "provb/claude-test-1",
          ownedBy: "anthropic",
          name: "Claude Test 1 (provb)",
          context: 100_000,
          maxOutput: 32_000,
          input: ["text"],
          output: ["text"],
          reasoning: { levels: ["medium", "high"], min: 1_024, max: 32_000, zeroAllowed: false },
          price: { rates: { input: 2, output: 10, cacheRead: 0.2 }, context: [] },
        },
        {
          // An ID with a slash of its own matches exactly; a null price is no price.
          id: "vendor/slashed-1",
          ownedBy: "provc",
          name: "Slashed",
          context: 128_000,
          input: ["text"],
          output: ["text", "image"],
        },
        { id: "custom-1", ownedBy: "provc", name: "Custom One", context: 50_000, maxOutput: 4_000 },
        {
          id: "manual-1",
          ownedBy: "provc",
          name: "Named By Setting",
          maxOutput: 8_000,
          price: { rates: { input: 1, output: 2 }, context: [] },
        },
      ])
      expect(server.seen.toSorted()).toEqual(["/pacer/v1/capabilities", "/pacer/v1/models", "/v1/models"])
    }),
  )

  it.live("lists a plain proxy's models without facts, prices or pacer", () =>
    Effect.gen(function* () {
      const answers: Array<() => Response> = [
        () => new Response("404 page not found", { status: 404 }),
        () => Response.json({ error: { type: "unauthorized", message: "no" } }, { status: 401 }),
        () => Response.json({ ...capabilities, pacer: null }),
        () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
      ]
      for (const answer of answers) {
        const server = yield* serve({
          ...cpp(),
          "/v1/models": () => Response.json({ object: "list", data: [listed.data[0]] }),
          "/pacer/v1/capabilities": answer,
        })
        const { models } = yield* start(endpoint(server.origin))
        expect(yield* until(models, loaded)).toMatchObject({
          pacer: null,
          models: [{ id: "claude-test-1", ownedBy: "anthropic" }],
        })
        expect(Object.keys((yield* models.get())?.models[0] ?? {})).toEqual(["id", "ownedBy"])
      }
    }),
  )

  it.live("keeps the last catalog when a read fails, and the last prices while only they are unreachable", () =>
    Effect.gen(function* () {
      const server = yield* serve(cpp())
      const { models } = yield* start(endpoint(server.origin))
      const first = yield* until(models, loaded)

      server.answers["/v1/models"] = () => new Response("down", { status: 500 })
      yield* models.refresh()
      expect(yield* models.get()).toBe(first)

      server.answers["/v1/models"] = cpp()["/v1/models"]
      server.answers["/pacer/v1/capabilities"] = () =>
        Response.json({ error: { type: "busy", message: "busy" } }, { status: 503, headers: { "retry-after": "1" } })
      yield* models.refresh()
      expect(yield* models.get()).toBe(first)

      server.answers["/pacer/v1/capabilities"] = cpp()["/pacer/v1/capabilities"]
      server.answers["/pacer/v1/models"] = () => new Response("down", { status: 502 })
      yield* models.refresh()
      const kept = yield* models.get()
      expect(kept).not.toBe(first)
      expect(kept?.models).toEqual(first?.models)

      // An answer that is not CPP's prices is no prices.
      server.answers["/pacer/v1/models"] = () => new Response("404 page not found", { status: 404 })
      yield* models.refresh()
      expect((yield* models.get())?.models.map((model) => model.price)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ])
    }),
  )

  it.live("follows the endpoint: a new address clears the catalog at once, a new key keeps it", () =>
    Effect.gen(function* () {
      const a = yield* serve(cpp())
      const b = yield* serve({
        ...cpp(),
        "/v1/models": () => Response.json({ object: "list", data: [{ id: "other-1", owned_by: "provc" }] }),
      })
      const { models, set } = yield* start(endpoint(a.origin))
      yield* until(models, loaded)
      const seen: Array<string | undefined> = []
      const watcher = yield* models.changes().pipe(
        Stream.runForEach((catalog) => Effect.sync(() => seen.push(catalog?.models[0]?.id))),
        Effect.forkScoped,
      )
      yield* eventually(() => seen.length > 0)

      yield* set(endpoint(b.origin))
      yield* eventually(() => seen.at(-1) === "other-1")
      expect(seen).toEqual(["claude-test-1", undefined, "other-1"])

      const reads = b.seen.length
      yield* set(endpoint(b.origin, "other-key"))
      yield* eventually(() => b.seen.length >= reads + 3 && seen.length === 4)
      expect(seen).toEqual(["claude-test-1", undefined, "other-1", "other-1"])

      yield* set(undefined)
      yield* until(models, (catalog) => catalog === undefined)
      yield* Fiber.interrupt(watcher)
    }),
  )

  it.live("drops a read of an address it has left, without waiting for it", () =>
    Effect.gen(function* () {
      const hung = yield* serve({ ...cpp(), "/v1/models": () => new Promise<Response>(() => {}) })
      const b = yield* serve({
        ...cpp(),
        "/v1/models": () => Response.json({ object: "list", data: [{ id: "other-1", owned_by: "provc" }] }),
      })
      const { models, set } = yield* start(endpoint(hung.origin))
      yield* eventually(() => hung.seen.includes("/v1/models"))
      const started = Date.now()
      yield* set(endpoint(b.origin))
      expect((yield* until(models, loaded))?.models.map((model) => model.id)).toEqual(["other-1"])
      // Well under PacerHttp's 10 s timeout for the hung read.
      expect(Date.now() - started).toBeLessThan(2_000)
    }),
  )

  it.live("reads only at start, on an endpoint change and on refresh: no timer", () =>
    Effect.gen(function* () {
      const server = yield* serve(cpp())
      const { models } = yield* start(endpoint(server.origin))
      yield* until(models, loaded)
      expect(server.seen.length).toBe(3)
      yield* Effect.sleep("300 millis")
      expect(server.seen.length).toBe(3)
      yield* models.refresh()
      expect(server.seen.length).toBe(6)
    }),
  )

  it.live("has no catalog and reads nothing while CPP is not set up", () =>
    Effect.gen(function* () {
      const { models } = yield* start(undefined)
      yield* models.refresh()
      expect(yield* models.get()).toBeUndefined()
    }),
  )
})
