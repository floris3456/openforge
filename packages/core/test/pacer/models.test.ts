import { describe, expect } from "bun:test"
import { Context, Effect, Fiber, Layer, Logger, Option, Stream, SubscriptionRef } from "effect"
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

/** Runs `body` with every warning logged meanwhile in hand, as `[message, annotations]`. */
const logged = <A, E, R>(body: (warnings: ReadonlyArray<ReadonlyArray<unknown>>) => Effect.Effect<A, E, R>) => {
  const warnings: Array<ReadonlyArray<unknown>> = []
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message as ReadonlyArray<unknown>)
  })
  return body(warnings).pipe(Effect.provide(Logger.layer([logger])))
}

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
      expect(catalog?.pacer).toEqual({
        compactTokens: ["auto", "before-cold", "cold"],
        webTools: false,
        freezePrompt: true,
      })
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
          // The providers of its routes; a route this version can't read is left out.
          providers: ["prova", "provb"],
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
          providers: ["provb"],
        },
        {
          // An ID with a slash of its own matches exactly; a null price is no price.
          id: "vendor/slashed-1",
          ownedBy: "provc",
          name: "Slashed",
          context: 128_000,
          input: ["text"],
          output: ["text", "image"],
          providers: ["provc"],
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

  it.live("lists the providers whose accounts serve each model, API keys too, and those only some of whose do", () =>
    Effect.gen(function* () {
      // As the owner's CLIProxyPacer answered on 2026-11-08: Claude's commandcode route is its API key only (1 of its 9
      // accounts), while a GPT model is served by every commandcode account; API keys have meters too.
      const server = yield* serve({
        ...cpp(),
        "/pacer/v1/capabilities": () =>
          Response.json({
            ...capabilities,
            providers: [
              { provider: "claude", login: "oauth", accounts: 8 },
              { provider: "commandcode", login: "oauth", accounts: 8 },
              { provider: "opencode-go", login: "oauth", accounts: 2 },
              { provider: "opencode-go", login: "api_key", accounts: 1 },
              { provider: "commandcode", login: "api_key", accounts: 1 },
              { provider: "codex", login: "oauth", accounts: 3 },
              "not a login",
            ],
            models: [
              {
                id: "claude-test-1",
                routes: [
                  { provider: "claude", login: "oauth", accounts: 8 },
                  { provider: "commandcode", login: "api_key", accounts: 1 },
                  { provider: "opencode-go", login: "oauth", accounts: 2 },
                  { provider: "opencode-go", login: "api_key", accounts: 1 },
                ],
              },
              {
                id: "vendor/slashed-1",
                routes: [
                  // Two of the three codex accounts.
                  { provider: "Codex", login: "oauth", accounts: 2 },
                  { provider: "commandcode", login: "oauth", accounts: 8 },
                  { provider: "commandcode", login: "api_key", accounts: 1 },
                  // A provider capabilities doesn't count, and a route that doesn't count: all, as before.
                  { provider: "plug" },
                ],
              },
              { id: "image-1", routes: [{ provider: "commandcode", login: "api_key" }] },
            ],
          }),
      })
      const { models } = yield* start(endpoint(server.origin))
      const catalog = yield* until(models, loaded)
      expect(PacerModels.served(catalog)).toEqual({
        items: [
          { id: "claude-test-1", providers: ["claude", "commandcode", "opencode-go"], partial: ["commandcode"] },
          // Pinned to a provider without a route of its own: the base model's routes.
          {
            id: "provb/claude-test-1",
            providers: ["claude", "commandcode", "opencode-go"],
            partial: ["commandcode"],
          },
          // Once each, in lower case, as the accounts name them.
          { id: "vendor/slashed-1", providers: ["codex", "commandcode", "plug"], partial: ["codex"] },
          { id: "custom-1", providers: [] },
          { id: "manual-1", providers: [] },
        ],
      })
      expect(catalog?.models[0]?.partial).toEqual(["commandcode"])
      expect(catalog?.models.find((model) => model.id === "custom-1")?.providers).toBeUndefined()
      expect(catalog?.models.find((model) => model.id === "custom-1")?.partial).toBeUndefined()
      // Without the pacer, or before a read: none.
      expect(PacerModels.served(undefined)).toBeUndefined()
      expect(PacerModels.served({ ...catalog!, pacer: null })).toBeUndefined()
    }),
  )

  it.live(
    "a model pinned to a provider is that provider's accounts, partial when its route doesn't count them all",
    () =>
      Effect.gen(function* () {
        const server = yield* serve({
          ...cpp(),
          "/v1/models": () =>
            Response.json({ object: "list", data: [{ id: "commandcode/claude-test-1", object: "model" }] }),
          "/pacer/v1/capabilities": () =>
            Response.json({
              ...capabilities,
              providers: [
                { provider: "claude", login: "oauth", accounts: 8 },
                { provider: "commandcode", login: "oauth", accounts: 8 },
                { provider: "commandcode", login: "api_key", accounts: 1 },
              ],
              models: [
                {
                  id: "claude-test-1",
                  routes: [
                    { provider: "claude", login: "oauth", accounts: 8 },
                    { provider: "commandcode", login: "api_key", accounts: 1 },
                  ],
                },
              ],
            }),
        })
        const { models } = yield* start(endpoint(server.origin))
        const catalog = yield* until(models, loaded)
        expect(PacerModels.served(catalog)).toEqual({
          items: [{ id: "commandcode/claude-test-1", providers: ["commandcode"], partial: ["commandcode"] }],
        })
      }),
  )

  it.live("says the server has the web tools while capabilities' pacer block names their list's path", () =>
    Effect.gen(function* () {
      const webTools = {
        tools: "/pacer/v1/tools",
        call: "/pacer/v1/tools/{name}",
        version_header: "X-Pacer-Tools",
        fallback: true,
        mcp: "/pacer/v1/mcp",
        mcp_revision: "2025-11-25",
      }
      const told = (web_tools: unknown) =>
        Effect.gen(function* () {
          const server = yield* serve({
            ...cpp(),
            "/pacer/v1/capabilities": () =>
              Response.json({ ...capabilities, pacer: { ...capabilities.pacer, web_tools } }),
          })
          const { models } = yield* start(endpoint(server.origin))
          return yield* until(models, loaded)
        })
      expect((yield* told(webTools))?.pacer).toEqual({
        compactTokens: ["auto", "before-cold", "cold"],
        webTools: true,
        freezePrompt: true,
      })
      expect((yield* told({ tools: "/pacer/v1/tools" }))?.pacer?.webTools).toBe(true)
      // An older server leaves the block out; one this version cannot read is no web tools, and the rest stands.
      for (const unread of [undefined, null, { call: "/pacer/v1/tools/{name}" }, { tools: 7 }, "yes"]) {
        const catalog = yield* told(unread)
        expect(catalog?.pacer).toEqual({
          compactTokens: ["auto", "before-cold", "cold"],
          webTools: false,
          freezePrompt: true,
        })
        expect(catalog?.models).toHaveLength(5)
      }
    }),
  )

  it.live("says whether a warm chat's prompt is kept, as capabilities' pacer.freeze_prompt says; on without it", () =>
    Effect.gen(function* () {
      const told = (freeze: unknown) =>
        Effect.gen(function* () {
          const server = yield* serve({
            ...cpp(),
            "/pacer/v1/capabilities": () =>
              Response.json({ ...capabilities, pacer: { ...capabilities.pacer, freeze_prompt: freeze } }),
          })
          const { models } = yield* start(endpoint(server.origin))
          return yield* until(models, loaded)
        })
      expect((yield* told(false))?.pacer?.freezePrompt).toBe(false)
      expect((yield* told(true))?.pacer?.freezePrompt).toBe(true)
      for (const unread of [undefined, null, "no"]) expect((yield* told(unread))?.pacer?.freezePrompt).toBe(true)
    }),
  )

  it.live("reads capabilities' pacer.tools, each tool on its own; absent without the field", () =>
    Effect.gen(function* () {
      const told = (tools: unknown) =>
        Effect.gen(function* () {
          const server = yield* serve({
            ...cpp(),
            "/pacer/v1/capabilities": () => Response.json({ ...capabilities, pacer: { ...capabilities.pacer, tools } }),
          })
          const { models } = yield* start(endpoint(server.origin))
          return (yield* until(models, loaded))?.pacer?.tools
        })
      const search = { title: "Web search", permission: "websearch", subject: ["query"], read_only: true }
      const read = yield* told({ web_search: search, remember: { title: "Remember" }, recall: "no" })
      expect(read && Object.fromEntries(read)).toEqual({ web_search: search })
      for (const unread of [undefined, null, ["web_search"]]) expect(yield* told(unread)).toBeUndefined()
      // Web tools in Code Mode: where the meta places a tool, and a Code Mode tool's definition.
      const definition = { name: "web_search", description: "Search the web.", input_schema: { type: "object" } }
      const placed = yield* told({
        web_search: { ...search, codemode: true, definition },
        remember: { ...search, codemode: false },
      })
      expect(placed && Object.fromEntries(placed)).toEqual({
        web_search: {
          ...search,
          codemode: true,
          definition: { description: "Search the web.", input_schema: { type: "object" } },
        },
        remember: { ...search, codemode: false },
      })
      // The arguments whose strings are local files, as the task tool's pictures: kept, and a tool whose field is not a
      // list of names drops on its own.
      const task = { title: "Task", permission: "memory", subject: ["id"], read_only: false, files: ["pictures"] }
      const filed = yield* told({ web_search: search, task, remember: { ...search, files: "pictures" } })
      expect(filed && Object.fromEntries(filed)).toEqual({ web_search: search, task })
    }),
  )

  // Workspace spec `docs/specs/compaction-threshold-per-client.md`: the key's entry for a model, below its window, is
  // where its chats compact. CLIProxyPacer's `capabilities` notice reads capabilities again (`PacerConnection`, which
  // calls `refresh`), so a changed entry moves the point.
  it.live("reads each model's compaction point from capabilities' compaction_limits, and a new read moves it", () =>
    Effect.gen(function* () {
      const limits: Record<string, unknown> = {
        "claude-test-1": { max_input_tokens: 60_000, max_output_tokens: null },
        // Without an entry CPP answers the model's context itself.
        "vendor/slashed-1": { max_input_tokens: 128_000, max_output_tokens: null },
        "manual-1": { max_input_tokens: 30_000 },
      }
      const server = yield* serve({
        ...cpp(),
        "/pacer/v1/capabilities": () =>
          Response.json({
            ...capabilities,
            models: [
              ...capabilities.models.map((model) =>
                typeof model === "object" && model.id in limits
                  ? { ...model, compaction_limits: limits[model.id] }
                  : model,
              ),
              // No context known: without an entry CPP answers null, so a number is an entry.
              { id: "manual-1", routes: [{ provider: "provc" }], compaction_limits: limits["manual-1"] },
            ],
          }),
      })
      const { models } = yield* start(endpoint(server.origin))
      const points = (catalog: PacerModels.Catalog | undefined) =>
        Object.fromEntries((catalog?.models ?? []).map((model) => [model.id, model.compact]))
      expect(points(yield* until(models, loaded))).toEqual({
        "claude-test-1": 60_000,
        // Pinned to a provider: its base model's.
        "provb/claude-test-1": 60_000,
        "vendor/slashed-1": undefined,
        "custom-1": undefined,
        "manual-1": 30_000,
      })

      limits["claude-test-1"] = { max_input_tokens: 80_000 }
      // Above the window it could never be reached: none.
      limits["vendor/slashed-1"] = { max_input_tokens: 200_000 }
      // A shape this version does not read leaves the model's other facts alone.
      limits["manual-1"] = "thirty thousand"
      yield* models.refresh()
      const moved = yield* models.get()
      expect(points(moved)).toEqual({
        "claude-test-1": 80_000,
        "provb/claude-test-1": 80_000,
        "vendor/slashed-1": undefined,
        "custom-1": undefined,
        "manual-1": undefined,
      })
      expect(moved?.models.find((model) => model.id === "manual-1")?.providers).toEqual(["provc"])

      // The entry removed: CPP answers the context again, or null where the routes disagree.
      limits["claude-test-1"] = { max_input_tokens: null }
      yield* models.refresh()
      expect(points(yield* models.get())["claude-test-1"]).toBeUndefined()
    }),
  )

  it.live(
    "says the server has memory, with its limits, while capabilities' pacer block holds memory of version 1",
    () =>
      Effect.gen(function* () {
        const told = (memory: unknown) =>
          Effect.gen(function* () {
            const server = yield* serve({
              ...cpp(),
              "/pacer/v1/capabilities": () =>
                Response.json({ ...capabilities, pacer: { ...capabilities.pacer, memory } }),
            })
            const { models } = yield* start(endpoint(server.origin))
            return yield* until(models, loaded)
          })
        const block = { version: 1, entry_characters: 800, query_characters: 2000, search_limit: 20 }
        expect((yield* told({ ...block, embedding: "granite-embedding-english-r2" }))?.pacer).toEqual({
          compactTokens: ["auto", "before-cold", "cold"],
          webTools: false,
          freezePrompt: true,
          memory: {
            version: 1,
            entryCharacters: 800,
            queryCharacters: 2000,
            searchLimit: 20,
            embedding: "granite-embedding-english-r2",
            tasks: false,
            plans: false,
            recalls: false,
            projects: false,
            prompt: false,
            summary: false,
            tools: false,
            goals: false,
            later: false,
            reviewItems: false,
            reviewOwed: false,
            inspect: false,
            news: false,
          },
        })
        expect((yield* told({ ...block, embedding: null, tasks: true }))?.pacer?.memory).toMatchObject({
          embedding: null,
          tasks: true,
          plans: false,
          recalls: false,
        })
        // Plans are a kind of tasks: a server that says plans without tasks has neither.
        expect((yield* told({ ...block, embedding: null, tasks: true, plans: true }))?.pacer?.memory).toMatchObject({
          tasks: true,
          plans: true,
        })
        expect((yield* told({ ...block, embedding: null, plans: true }))?.pacer?.memory).toMatchObject({
          tasks: false,
          plans: false,
        })
        expect((yield* told({ ...block, embedding: null, recalls: true }))?.pacer?.memory).toMatchObject({
          tasks: false,
          recalls: true,
        })
        // A server that keeps memory per project says so.
        expect((yield* told({ ...block, embedding: null, projects: true }))?.pacer?.memory).toMatchObject({
          recalls: false,
          projects: true,
        })
        // A server that answers each prompt's close entries says so.
        expect((yield* told({ ...block, embedding: null, prompt: true }))?.pacer?.memory).toMatchObject({
          projects: false,
          prompt: true,
        })
        // A server that serves the memory tools and memory's texts says so.
        expect((yield* told({ ...block, embedding: null, tools: true }))?.pacer?.memory).toMatchObject({ tools: true })
        // A server with goals and active time says so.
        expect((yield* told({ ...block, embedding: null, goals: true }))?.pacer?.memory).toMatchObject({ goals: true })
        // A server with the task system's later items says so.
        expect((yield* told({ ...block, embedding: null, later: true }))?.pacer?.memory).toMatchObject({
          goals: false,
          later: true,
        })
        // A server with agents' notes on review items says so.
        expect((yield* told({ ...block, embedding: null, review_items: true }))?.pacer?.memory).toMatchObject({
          later: false,
          reviewItems: true,
        })
        // A server that says what a lead owes its helper's rounds says so (task khtzd8a7qje3).
        expect((yield* told({ ...block, embedding: null, review_owed: true }))?.pacer?.memory).toMatchObject({
          reviewItems: false,
          reviewOwed: true,
        })
        // A server with the reads of other projects says so (workspace spec cpp-inspect-cli).
        expect((yield* told({ ...block, embedding: null, inspect: true }))?.pacer?.memory).toMatchObject({
          reviewItems: false,
          inspect: true,
        })
        // A server that keeps blocker news for the chats to tell says so (workspace spec blocker-tasks).
        expect((yield* told({ ...block, embedding: null, news: true }))?.pacer?.memory).toMatchObject({
          inspect: false,
          news: true,
        })
        // A server whose start takes a compaction's summary says so.
        expect((yield* told({ ...block, embedding: null, prompt: true, summary: true }))?.pacer?.memory).toMatchObject({
          prompt: true,
          summary: true,
        })
        // Left out, or in a version or shape this one cannot read: no memory, and the rest stands.
        for (const unread of [
          undefined,
          null,
          { ...block, version: 2, embedding: null },
          { ...block, embedding: 7 },
          { ...block },
          { ...block, search_limit: 0, embedding: null },
          "yes",
        ]) {
          const catalog = yield* told(unread)
          expect(catalog?.pacer).toEqual({
            compactTokens: ["auto", "before-cold", "cold"],
            webTools: false,
            freezePrompt: true,
          })
          expect(catalog?.models).toHaveLength(5)
        }
      }),
  )

  it.live("says per route whether CLIProxyPacer writes a model's summaries itself, as its server_writes decides", () =>
    Effect.gen(function* () {
      // The routes as the owner's CPP gave them for a key whose writer is unset (2026-11-12): `server_writes` says
      // whether CPP writes the route's summary with `compaction.writer = server`, whatever `remote_compaction` the key
      // gets; a CommandCode API key's chat model is `unsupported` and written. A route without it (CPP before
      // c1ac59ed) is written only where it says `emulated`.
      const route = (provider: string, remote_compaction?: string | null, server_writes?: boolean | null) => ({
        provider,
        ...(remote_compaction !== undefined ? { remote_compaction } : {}),
        ...(server_writes !== undefined ? { server_writes } : {}),
      })
      const server = yield* serve({
        ...cpp(),
        "/v1/models": () =>
          Response.json({
            object: "list",
            data: [
              "deepseek/deepseek-w",
              "decision-w",
              "claude-w",
              "gpt-w",
              "codex/gpt-w",
              "said-w",
              "old-w",
              "plain-w",
            ].map((id) => ({ id })),
          }),
        "/pacer/v1/capabilities": () =>
          Response.json({
            ...capabilities,
            models: [
              { id: "deepseek/deepseek-w", routes: [route("commandcode", "unsupported", true)] },
              { id: "decision-w", routes: [route("commandcode", "unsupported", false)] },
              { id: "claude-w", routes: [route("claude", "emulated", true), route("antigravity", "emulated", true)] },
              { id: "gpt-w", routes: [route("codex", "unsupported", true), route("opencode-go", "forwarded", false)] },
              // `server_writes` decides, also against `remote_compaction` or without it.
              { id: "said-w", routes: [route("plug", "emulated", false), route("other", undefined, true)] },
              {
                id: "old-w",
                routes: [
                  route("claude", "emulated"),
                  route("codex", "unsupported"),
                  route("opencode-go", "forwarded"),
                  route("openai-compatibility", "native"),
                  route("plug", null, null),
                ],
              },
              { id: "plain-w", routes: [route("plug")] },
            ],
          }),
      })
      const { models } = yield* start(endpoint(server.origin))
      const catalog = yield* until(models, loaded)
      const summaries = Object.fromEntries((catalog?.models ?? []).map((model) => [model.id, model.summaries]))
      expect(summaries).toEqual({
        "deepseek/deepseek-w": [{ provider: "commandcode", writes: true }],
        "decision-w": [{ provider: "commandcode", writes: false }],
        "claude-w": [
          { provider: "claude", writes: true },
          { provider: "antigravity", writes: true },
        ],
        "gpt-w": [
          { provider: "codex", writes: true },
          { provider: "opencode-go", writes: false },
        ],
        // The provider the ID names: its routes only.
        "codex/gpt-w": [{ provider: "codex", writes: true }],
        "said-w": [
          { provider: "plug", writes: false },
          { provider: "other", writes: true },
        ],
        "old-w": [
          { provider: "claude", writes: true },
          { provider: "codex", writes: false },
          { provider: "opencode-go", writes: false },
          { provider: "openai-compatibility", writes: false },
          { provider: "plug", writes: false },
        ],
        // No route says: nothing is known.
        "plain-w": undefined,
      })

      // A chat on one provider's account is written where that provider's routes write; with none of its own, or not
      // known, every route must write, since CPP may pick any of them.
      const writes = (id: string, provider?: string) =>
        PacerModels.writes(
          catalog?.models.find((model) => model.id === id),
          provider,
        )
      // A Claude chat's summary on CommandCode's DeepSeek, as the cold ask names it first.
      expect(writes("deepseek/deepseek-w", "claude")).toBe(true)
      expect(writes("decision-w")).toBe(false)
      expect(writes("claude-w")).toBe(true)
      expect(writes("gpt-w", "codex")).toBe(true)
      expect(writes("gpt-w", "Codex")).toBe(true)
      expect(writes("gpt-w", "opencode-go")).toBe(false)
      expect(writes("gpt-w")).toBe(false)
      expect(writes("gpt-w", "claude")).toBe(false)
      expect(writes("said-w", "other")).toBe(true)
      expect(writes("said-w")).toBe(false)
      expect(writes("old-w", "claude")).toBe(true)
      expect(writes("old-w", "codex")).toBe(false)
      expect(writes("plain-w")).toBe(false)
      expect(writes("missing-w")).toBe(false)
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

  it.live("fails a first read that gets a 429, a 408 or a redirect, and finds the pacer at its next read", () =>
    Effect.gen(function* () {
      const answers: Array<() => Response> = [
        () => Response.json({ error: { type: "rate_limited", message: "slow down" } }, { status: 429 }),
        () => new Response("request timeout", { status: 408 }),
        () => Response.redirect("http://127.0.0.1/elsewhere", 302),
      ]
      for (const answer of answers) {
        const server = yield* serve({ ...cpp(), "/pacer/v1/capabilities": answer })
        const { models } = yield* start(endpoint(server.origin))
        yield* eventually(() => server.seen.includes("/pacer/v1/capabilities"))
        yield* models.refresh()
        // No catalog: the server is not taken for a plain proxy, so `PacerTools` still reads each chat's own list.
        expect(yield* models.get()).toBeUndefined()

        server.answers["/pacer/v1/capabilities"] = cpp()["/pacer/v1/capabilities"]
        yield* models.refresh()
        expect(yield* models.get()).toMatchObject({ pacer: { webTools: false } })
      }
    }),
  )

  it.live("takes a server that serves a page at every path for a plain proxy, with a warning", () =>
    logged((warnings) =>
      Effect.gen(function* () {
        const server = yield* serve({
          ...cpp(),
          "/pacer/v1/capabilities": () =>
            new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
        })
        const { models } = yield* start(endpoint(server.origin))
        expect(yield* until(models, loaded)).toMatchObject({ pacer: null })
        expect(warnings).toHaveLength(1)
        expect(warnings[0]![0]).toBe("took CLIProxyPacer for a plain proxy: capabilities answered a page")
        expect(warnings[0]![1]).toMatchObject({ status: 200 })
      }),
    ),
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
