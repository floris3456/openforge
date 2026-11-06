import { describe, expect } from "bun:test"
import { ai } from "@opencode/ai/effect"
import { Effect, Schedule, Schema, SubscriptionRef } from "effect"
import { Headers } from "effect/http"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerModels } from "@opencode/core/pacer/models"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { CLIProxyPacerPlugin, isClaude } from "@opencode/core/plugin/provider/cliproxypacer"
import { Provider } from "@opencode/core/provider"
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
  pacer: { compactTokens: ["auto", "before-cold", "cold"] },
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
      expect(required(plain).cost).toEqual([rates(0, 0, 0, 0)])
      expect(required(plain).variants.map((variant) => String(variant.id))).toEqual(["low", "medium", "high"])
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
