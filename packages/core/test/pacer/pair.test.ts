import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { AIError, ai } from "@opencode/ai/effect"
import { LLMClient, RequestExecutor } from "@opencode/ai/route"
import { Context, Effect, Layer, Option, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { Database } from "@opencode/core/database/database"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { CLIProxyPacerPlugin } from "@opencode/core/plugin/provider/cliproxypacer"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { WellKnown } from "@opencode/core/wellknown"
import { emptyWellknownNode } from "../fixture/config-nodes"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

// Synthetic: no real address or key.
const key = "k-pair"
const providerID = Provider.ID.make("cliproxypacer")

/**
 * One instance of CPP's pair on a local server: `/healthz`, the catalog's three reads and the Responses route, which
 * records each body it gets. `down` makes it answer every request 502, as the tunnel does while the instance is away;
 * `stop` refuses connections.
 */
const fakeInstance = Effect.acquireRelease(
  Effect.sync(() => {
    const state = {
      down: false,
      addresses: undefined as unknown,
      health: 0,
      bodies: [] as string[],
      keyed: [] as boolean[],
    }
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.pathname === "/healthz") state.health++
        if (state.down) return new Response("bad gateway", { status: 502 })
        if (url.pathname === "/healthz") return new Response("ok")
        const keyed = request.headers.get("authorization") === `Bearer ${key}`
        if (!keyed) return Response.json({ error: { message: "no key" } }, { status: 401 })
        if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "gpt-pair-1", owned_by: "openai" }] })
        if (url.pathname === "/pacer/v1/capabilities")
          return Response.json({
            pacer: { compact_tokens: [], ...(state.addresses === undefined ? {} : { addresses: state.addresses }) },
            providers: [],
            models: [],
          })
        if (url.pathname === "/pacer/v1/models") return Response.json({ models: [], manual: [], settings: [] })
        if (url.pathname === "/v1/responses") {
          state.bodies.push(await request.text())
          return new Response(
            [
              { type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress" } },
              { type: "response.completed", response: { id: "resp_1", object: "response", status: "completed" } },
            ]
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        return new Response("not found", { status: 404 })
      },
    })
    return { state, server, root: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
  }),
  (instance) => Effect.promise(() => instance.server.stop(true)),
)
type Instance = Effect.Success<typeof fakeInstance>

/** The answering instance first, then its peer, the public address last, as CPP lists them. */
const listed = (active: Instance, peer: Instance, extra: ReadonlyArray<unknown> = []) => [
  { url: active.root, instance: "a", active: true },
  { url: peer.root, instance: "b", active: false },
  ...extra,
]

/** The real endpoint, client API and catalog over config under `root`, their state in the database at `database`. */
const pacer = (root: string, database: string) => {
  const watcher = Watcher.testLayer
  return Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        PacerEndpoint.node,
        PacerHttp.node,
        PacerModels.node,
        Integration.node,
        Credential.node,
        Bus.node,
        Database.node,
      ]),
      {
        replacements: [
          PacerEndpoint.node.replace(PacerEndpoint.configured({ system: false })),
          Database.node.replace(Database.configured({ path: database })),
          Global.node.replace(Global.layerWith({ config: path.join(root, "config"), home: path.join(root, "home") })),
          WellKnown.node.replace(emptyWellknownNode),
          Watcher.node.replace(watcher),
        ],
      },
    ),
    watcher,
  )
}

/** A fresh root whose config sets CPP up at `home`, and the database file its state goes in. */
const setUp = (home: Instance) =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped()).path
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(root, "config"), { recursive: true })
      await fs.writeFile(
        path.join(root, "config", "opencode.json"),
        JSON.stringify({ providers: { cliproxypacer: { settings: { baseURL: `${home.root}/v1`, apiKey: key } } } }),
      )
    })
    return { root, database: path.join(root, "state.db") }
  })

const started = (root: string, database: string) =>
  Effect.gen(function* () {
    // Fresh: the plugin layer holds its own client API and catalog over an endpoint without config.
    const context = yield* Layer.build(Layer.fresh(pacer(root, database)))
    return {
      endpoints: Context.get(context, PacerEndpoint.Service),
      catalogs: Context.get(context, PacerModels.Service),
    }
  })

/** Waits, in real time, for `effect` to give a value `predicate` takes. */
const until = <A, E, R>(effect: Effect.Effect<A, E, R>, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* Effect.promise(() => Bun.sleep(5))
    }
    return yield* Effect.die(new Error(`timed out waiting: ${JSON.stringify(yield* effect)}`))
  })

const roots = (endpoints: PacerEndpoint.Interface) =>
  Effect.suspend(() => endpoints.addresses?.() ?? Effect.succeed([])).pipe(
    Effect.map((list) => list.map((item) => item.root)),
  )

const at = (endpoints: PacerEndpoint.Interface) => endpoints.get().pipe(Effect.map((endpoint) => endpoint?.root))

/** The plugin's model as the model service lists it now. */
const model = Effect.gen(function* () {
  const models = yield* Model.Service
  return (yield* models.available()).find((item) => item.providerID === providerID && String(item.id) === "gpt-pair-1")
})

/** One step: a request of the model as the plugin pins it now, through its route; its failure, if it failed. */
const step = Effect.gen(function* () {
  const info = yield* model
  if (!info) return yield* Effect.die(new Error("no model"))
  const resolved = yield* ModelResolver.fromCatalogModel(info)
  const exit = yield* LLMClient.stream(ai.request({ model: resolved, prompt: "Hello" })).pipe(
    Stream.runDrain,
    Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.fresh)),
    Effect.provide(FetchHttpClient.layer),
    Effect.flip,
    Effect.option,
  )
  const failure = Option.getOrUndefined(exit)
  return failure instanceof AIError ? failure : undefined
})

/** The plugin, on these endpoint and catalog services. */
const plugged = (services: Effect.Success<ReturnType<typeof started>>) =>
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    yield* CLIProxyPacerPlugin.effect(yield* PluginHost.make(plugin)).pipe(
      Effect.provideService(PacerEndpoint.Service, services.endpoints),
      Effect.provideService(PacerModels.Service, services.catalogs),
    )
  })

/** What the step runner's retry policy decides on `failure`, with `endpoints` to move. */
const decided = (failure: AIError, endpoints: PacerEndpoint.Interface) =>
  Effect.gen(function* () {
    const decide = yield* SessionRunnerRetry.policy(Session.ID.make("ses_pair"), undefined, endpoints)
    return yield* decide({
      cause: failure,
      error: toSessionError(failure),
      agent: Agent.defaultID,
      model: Model.Ref.make({ id: Model.ID.make("gpt-pair-1"), providerID }),
      hook: () => Effect.void,
      retry: SessionRunnerRetry.isRetryable(failure),
    })
  })

/** The step's failure once `instance` stopped. */
const failedAt = (instance: Instance) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => instance.stop())
    const failure = yield* step
    if (!failure) return yield* Effect.die(new Error("the step to a stopped instance did not fail"))
    return failure
  })

const it = testEffect(PluginTestLayer)

describe("CPP's pair addresses", () => {
  it.live("an outage moves the next step to the other instance at once, with the same body", () =>
    Effect.gen(function* () {
      const a = yield* fakeInstance
      const b = yield* fakeInstance
      a.state.addresses = listed(a, b)
      b.state.addresses = listed(b, a)
      const files = yield* setUp(a)
      const services = yield* started(files.root, files.database)
      const endpoints = services.endpoints
      yield* until(roots(endpoints), (list) => list.length === 2)
      expect(yield* roots(endpoints)).toEqual([a.root, b.root])

      yield* plugged(services)
      yield* until(model, (info) => info?.settings?.baseURL === `${a.root}/v1`)
      expect(yield* step).toBeUndefined()
      expect(a.state.bodies).toHaveLength(1)

      const decision = yield* decided(yield* failedAt(a), endpoints)
      expect(decision).toMatchObject({ retry: true, delay: 0 })
      expect(yield* at(endpoints)).toBe(b.root)
      expect((yield* endpoints.get())?.home).toBe(a.root)

      // The provider reloads with the new address; the retried step goes there.
      yield* until(model, (info) => info?.settings?.baseURL === `${b.root}/v1`)
      expect(yield* step).toBeUndefined()
      expect(b.state.bodies).toEqual(a.state.bodies)
    }),
  )

  it.live("a service started while the first address is down reaches the second from the stored list", () =>
    Effect.gen(function* () {
      const a = yield* fakeInstance
      const b = yield* fakeInstance
      a.state.addresses = listed(a, b, [{ url: "https://public.invalid", public: true }])
      b.state.addresses = listed(b, a)
      const files = yield* setUp(a)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const endpoints = (yield* started(files.root, files.database)).endpoints
          yield* until(roots(endpoints), (list) => list.length === 3)
        }),
      )

      a.state.down = true
      const services = yield* started(files.root, files.database)
      // The first read fails at the set-up address; the move reads the catalog at the other.
      yield* until(at(services.endpoints), (root) => root === b.root)
      const catalog = yield* until(services.catalogs.get(), (value) => value !== undefined)
      expect(catalog?.models.map((item) => item.id)).toEqual(["gpt-pair-1"])
      // The public address, tried last, was not needed.
      expect(a.state.health).toBe(0)
    }),
  )

  it.effect("moves back after two answers of the first address a minute apart, and polls nothing there", () =>
    Effect.gen(function* () {
      const a = yield* fakeInstance
      const b = yield* fakeInstance
      a.state.addresses = listed(a, b)
      b.state.addresses = listed(b, a)
      const files = yield* setUp(a)
      const endpoints = (yield* started(files.root, files.database)).endpoints
      yield* until(roots(endpoints), (list) => list.length === 2)

      a.state.down = true
      expect(yield* endpoints.failover?.() ?? Effect.succeed(false)).toBe(true)
      expect(yield* at(endpoints)).toBe(b.root)

      // Still down at the first check: the count starts over.
      yield* TestClock.adjust("60 seconds")
      yield* until(
        Effect.sync(() => a.state.health),
        (count) => count === 1,
      )
      a.state.down = false
      yield* TestClock.adjust("60 seconds")
      yield* until(
        Effect.sync(() => a.state.health),
        (count) => count === 2,
      )
      expect(yield* at(endpoints)).toBe(b.root)
      yield* TestClock.adjust("60 seconds")
      yield* until(at(endpoints), (root) => root === a.root)
      expect((yield* endpoints.get())?.home).toBeUndefined()
      expect(a.state.health).toBe(3)

      yield* TestClock.adjust("10 minutes")
      yield* Effect.promise(() => Bun.sleep(50))
      expect(a.state.health).toBe(3)
    }),
  )

  it.live("takes no addresses from an unkeyed or foreign answer, nor malformed entries", () =>
    Effect.gen(function* () {
      const a = yield* fakeInstance
      const b = yield* fakeInstance
      a.state.addresses = [
        { url: a.root, instance: "a", active: true },
        { url: "not a url", instance: "x" },
        { instance: "no url" },
        "text",
        { url: `${b.root}/v1/`, instance: "b" },
        { url: b.root, instance: "b again" },
      ]
      const files = yield* setUp(a)
      const endpoints = (yield* started(files.root, files.database)).endpoints
      yield* until(roots(endpoints), (list) => list.length === 2)
      expect(yield* endpoints.addresses?.() ?? Effect.succeed([])).toEqual([
        { origin: a.root, root: a.root, baseURL: `${a.root}/v1`, instance: "a", active: true },
        { origin: b.root, root: b.root, baseURL: `${b.root}/v1`, instance: "b" },
      ])

      const home = yield* endpoints.get()
      if (!home || !endpoints.learn) return yield* Effect.die(new Error("not set up"))
      const elsewhere = PacerEndpoint.addressesOf([{ url: "https://elsewhere.invalid" }]) ?? []
      // Another key, as an answer to a request without ours.
      yield* endpoints.learn({ ...home, key: "k-other" }, elsewhere)
      // An address not in the list.
      yield* endpoints.learn({ ...home, origin: "https://foreign.invalid", root: "https://foreign.invalid" }, elsewhere)
      expect(yield* roots(endpoints)).toEqual([a.root, b.root])
      // The list's own address may change it.
      yield* endpoints.learn(home, elsewhere)
      expect(yield* roots(endpoints)).toEqual([a.root, "https://elsewhere.invalid"])
    }),
  )

  it.live("with one address (an older server), an outage moves nothing and the step waits as before", () =>
    Effect.gen(function* () {
      const a = yield* fakeInstance
      const files = yield* setUp(a)
      const services = yield* started(files.root, files.database)
      const endpoints = services.endpoints
      yield* plugged(services)
      yield* until(model, (info) => info?.settings?.baseURL === `${a.root}/v1`)
      expect(yield* roots(endpoints)).toEqual([a.root])
      const failure = yield* failedAt(a)
      // The wait as before: ModelRetry's backoff, not the move's 0.
      const decision = yield* decided(failure, endpoints)
      expect(decision).toMatchObject({ retry: true, attempt: 2 })
      expect(decision.retry && decision.delay).toBeGreaterThan(0)
      expect(yield* at(endpoints)).toBe(a.root)
      expect(a.state.health).toBe(0)
    }),
  )
})
