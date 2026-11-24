import { Context, Effect, Layer, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { KV } from "@opencode/core/kv"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerTools } from "@opencode/core/pacer/tools"
import list from "./fixtures/tools.json"

/** Each web tool's `meta`, as CPP's list gives it beside the tools (workspace reference `docs/reference/cpp-tools-api.md`). */
export const webMeta = {
  web_search: { title: "Web search", permission: "websearch", subject: ["query"], read_only: true },
  web_extract: { title: "Web extract", permission: "webfetch", subject: ["job_id", "urls"], read_only: true },
  web_crawl: { title: "Web crawl", permission: "webfetch", subject: ["job_id", "url"], read_only: true },
  web_research: { title: "Web research", permission: "websearch", subject: ["job_id", "question"], read_only: true },
}
const owner = { ...list, meta: webMeta }

/** The owner's CPP's list (`run/evidence/cpp-step-2/owner-list`, read without a chat): all four tools, with meta. */
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

/** A request to CPP's files route, whose body is the file's bytes rather than text. */
export interface ReceivedFile {
  readonly method: string
  readonly path: string
  readonly sha256: string
  readonly headers: Headers
  readonly bytes: Uint8Array
}

type Answer = (request: Received) => Response | Promise<Response>

/**
 * CPP's tool routes on a local server: `GET /pacer/v1/tools` and `POST /pacer/v1/tools/{name}`, each answered by a
 * function the test may change. It records what it gets, can hold answers until released, and counts the requests the
 * client gave up on. Its files route (`HEAD` and `PUT /pacer/v1/files/{sha256}`) keeps the bytes it is sent, answered
 * `200` once held and `404` before, and gives them back (`GET`); a review item's read (`GET
 * /pacer/v1/memory/{project}/tasks/{id}/items/{n}`) is answered by a function the test sets.
 */
export const fakeCpp = Effect.acquireRelease(
  Effect.sync(() => {
    const received: Received[] = []
    /** The files CPP holds, by their SHA-256. */
    const files = new Map<string, { readonly bytes: Uint8Array; readonly type: string | null }>()
    const uploads: ReceivedFile[] = []
    const answers: { list: Answer; call: Answer; item: Answer } = {
      list: () => Response.json(owner),
      call: (request) =>
        Response.json({
          text: `answered ${request.path}`,
          data: { tool: request.path.split("/").at(-1), provider: "tavily", cost_nano_usd: 8_000_000 },
          error: null,
          metadata: { provider: "Tavily" },
        }),
      item: () => Response.json({ error: { type: "not_found", message: "no such item" } }, { status: 404 }),
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
        const file = /^\/pacer\/v1\/files\/([0-9a-f]{64})$/.exec(url.pathname)
        if (file) {
          const sha256 = file[1]!
          const bytes = request.method === "PUT" ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array()
          uploads.push({ method: request.method, path: url.pathname, sha256, headers: request.headers, bytes })
          if (gate.held) await opened
          if (request.method === "HEAD") return new Response(null, { status: files.has(sha256) ? 200 : 404 })
          if (request.method === "GET") {
            const held = files.get(sha256)
            if (!held) return Response.json({ error: { type: "not_found", message: `no file ${sha256}` } }, { status: 404 })
            return new Response(held.bytes, { headers: { "content-type": held.type ?? "application/octet-stream" } })
          }
          if (request.method !== "PUT") return new Response("405", { status: 405 })
          const already = files.has(sha256)
          if (!already) files.set(sha256, { bytes, type: request.headers.get("content-type") })
          return Response.json({ sha256 }, { status: already ? 200 : 201 })
        }
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
        if (/^\/pacer\/v1\/memory\/[^/]+\/tasks\/[^/]+\/items\/\d+$/.test(item.path) && item.method === "GET")
          return answers.item(item)
        return new Response("404 page not found", { status: 404 })
      },
    })
    const lists = () => received.filter((item) => item.path === "/pacer/v1/tools")
    const calls = () => received.filter((item) => item.path.startsWith("/pacer/v1/tools/"))
    const heads = () => uploads.filter((item) => item.method === "HEAD")
    const puts = () => uploads.filter((item) => item.method === "PUT")
    return {
      origin: `http://127.0.0.1:${server.port}`,
      server,
      received,
      answers,
      gate,
      hold,
      lists,
      calls,
      files,
      uploads,
      heads,
      puts,
    }
  }),
  (cpp) => Effect.promise(() => cpp.server.stop(true)),
)
export type FakeCpp = Effect.Success<typeof fakeCpp>

export const endpointOf = (origin: string, key = "client-key-test") =>
  PacerEndpoint.resolve({ baseURL: `${origin}/v1`, apiKey: key }, undefined)!

/** A catalog; `tools` is capabilities' `pacer.tools`, which a server before it leaves out. */
export const catalogOf = (
  webTools: boolean | "no pacer",
  tools?: Readonly<Record<string, PacerTools.Meta>>,
): PacerModels.Catalog => ({
  at: 0,
  pacer:
    webTools === "no pacer"
      ? null
      : {
          compactTokens: ["auto", "before-cold"],
          webTools,
          ...(tools ? { tools: new Map(Object.entries(tools)) } : {}),
        },
  models: [],
})

/** PacerTools over the real PacerHttp and Bus, with CPP's endpoint and catalog in the test's hands. */
export const startTools = Effect.fnUntraced(function* (
  endpoint: PacerEndpoint.Endpoint | undefined,
  catalog: PacerModels.Catalog | undefined = catalogOf(true),
  /** The key-value store of an earlier start, kept across this one. */
  kept?: KV.Interface,
  /**
   * What the endpoint's lists named before, as an earlier start of openforge kept it: the four web tools by default,
   * so that a request offers them before its chat's list is read; none with `{}`.
   */
  known: Readonly<Record<string, PacerTools.Meta>> = webMeta,
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
  const base = yield* Layer.build(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, KV.node])))
  const bus = Context.get(base, Bus.Service)
  const kv = kept ?? Context.get(base, KV.Service)
  if (endpoint && !kept && Object.keys(known).length > 0) yield* kv.set(PacerTools.knownKey(endpoint), { ...known })
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
          Layer.succeed(KV.Service, kv),
        ),
      ),
    ),
  )
  return { tools: Context.get(context, PacerTools.Service), bus, kv, endpoints, catalogs }
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
