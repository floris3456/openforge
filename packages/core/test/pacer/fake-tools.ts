import { Context, Effect, Layer, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerTools } from "@opencode/core/pacer/tools"
import owner from "./fixtures/tools.json"

/** The owner's CPP's list (`run/evidence/cpp-step-2/owner-list`, read without a chat): all four tools. */
export const ownerList = owner
/** The `claude` shape's bytes as CPP wrote them. */
export const ownerClaude = JSON.stringify(owner.tools.claude)

/** A list answer of `tools` (the `claude` shape), under `version`. */
export const listOf = (version: string, tools: ReadonlyArray<unknown>) => ({
  ...owner,
  version,
  tools: { claude: tools, responses: [], chat: [] },
})
export const only = (...names: string[]) => owner.tools.claude.filter((tool) => names.includes(tool.name))

export interface Received {
  readonly method: string
  readonly path: string
  readonly query: URLSearchParams
  readonly headers: Headers
  readonly body: string
}

type Answer = (request: Received) => Response | Promise<Response>

/**
 * CPP's tool routes on a local server: `GET /pacer/v1/tools` and `POST /pacer/v1/tools/{name}`, each answered by a
 * function the test may change. It records what it gets, can hold answers until released, and counts the requests the
 * client gave up on.
 */
export const fakeCpp = Effect.acquireRelease(
  Effect.sync(() => {
    const received: Received[] = []
    const answers: { list: Answer; call: Answer } = {
      list: () => Response.json(owner),
      call: (request) =>
        Response.json({
          text: `answered ${request.path}`,
          data: { tool: request.path.split("/").at(-1), provider: "tavily", cost_nano_usd: 8_000_000 },
          error: null,
        }),
    }
    const gate = { held: false, release: () => {}, aborted: 0 }
    let opened = Promise.resolve()
    const hold = () => {
      gate.held = true
      opened = new Promise<void>((resolve) => {
        gate.release = () => {
          gate.held = false
          resolve()
        }
      })
    }
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      // A held answer may wait past Bun's own idle limit of 10 s.
      idleTimeout: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        request.signal.addEventListener("abort", () => void gate.aborted++)
        const item = {
          method: request.method,
          path: url.pathname,
          query: url.searchParams,
          headers: request.headers,
          body: await request.text(),
        }
        received.push(item)
        if (gate.held) await opened
        if (item.path === "/pacer/v1/tools" && item.method === "GET") return answers.list(item)
        if (item.path.startsWith("/pacer/v1/tools/") && item.method === "POST") return answers.call(item)
        return new Response("404 page not found", { status: 404 })
      },
    })
    const lists = () => received.filter((item) => item.path === "/pacer/v1/tools")
    const calls = () => received.filter((item) => item.path.startsWith("/pacer/v1/tools/"))
    return { origin: `http://127.0.0.1:${server.port}`, server, received, answers, gate, hold, lists, calls }
  }),
  (cpp) => Effect.promise(() => cpp.server.stop(true)),
)
export type FakeCpp = Effect.Success<typeof fakeCpp>

export const endpointOf = (origin: string, key = "client-key-test") =>
  PacerEndpoint.resolve({ baseURL: `${origin}/v1`, apiKey: key }, undefined)!

export const catalogOf = (webTools: boolean | "no pacer"): PacerModels.Catalog => ({
  at: 0,
  pacer: webTools === "no pacer" ? null : { compactTokens: ["auto", "before-cold"], webTools },
  models: [],
})

/** PacerTools over the real PacerHttp and Bus, with CPP's endpoint and catalog in the test's hands. */
export const startTools = Effect.fnUntraced(function* (
  endpoint: PacerEndpoint.Endpoint | undefined,
  catalog: PacerModels.Catalog | undefined = catalogOf(true),
) {
  const endpoints = yield* SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(endpoint)
  const catalogs = yield* SubscriptionRef.make<PacerModels.Catalog | undefined>(catalog)
  const endpointLayer = Layer.succeed(
    PacerEndpoint.Service,
    PacerEndpoint.Service.of({
      get: () => SubscriptionRef.get(endpoints),
      changes: () => SubscriptionRef.changes(endpoints),
    }),
  )
  const bus = Context.get(
    yield* Layer.build(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node]))),
    Bus.Service,
  )
  // Fresh: a test layer whose graph has these (the plugin fixture's) would hand back its own, which have no CPP.
  const context = yield* Layer.build(
    Layer.fresh(PacerTools.layer).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.fresh(PacerHttp.layer).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(endpointLayer)),
          endpointLayer,
          Layer.succeed(
            PacerModels.Service,
            PacerModels.Service.of({
              get: () => SubscriptionRef.get(catalogs),
              changes: () => SubscriptionRef.changes(catalogs),
              refresh: () => Effect.void,
            }),
          ),
          Layer.succeed(Bus.Service, bus),
        ),
      ),
    ),
  )
  return { tools: Context.get(context, PacerTools.Service), bus, endpoints, catalogs }
})

/** Waits, in real time and at most 5 s, until `check` holds: for what the server sees, which no event announces. */
export const until = (label: string, check: () => boolean) =>
  Effect.gen(function* () {
    const deadline = performance.now() + 5_000
    while (!check()) {
      if (performance.now() > deadline) return yield* Effect.die(new Error(`never happened: ${label}`))
      yield* TestClock.withLive(Effect.sleep("5 millis"))
    }
  })

/** Lets forked work and the server run for a moment, in real time. */
export const settle = TestClock.withLive(Effect.sleep("30 millis"))
