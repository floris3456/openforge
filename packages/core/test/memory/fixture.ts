import { Context, Effect, Layer, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { MemoryClient } from "@opencode/core/memory/client"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { capabilities, startMemoryServer } from "../pacer/memory-server"
import { endpointOf } from "../pacer/fake-tools"
import { startFakeEmbedding } from "../pacer/memory-embedding"

export const key = "memory-client-key-f1"
export const person = "floris"

/** What the proxy in front of the memory server got: the request as sent, before the server answers. */
export interface Received {
  readonly method: string
  readonly path: string
  readonly body: unknown
  /** CPP's own headers it got (`x-pacer-*`), by their lower-case names. */
  readonly pacer: Readonly<Record<string, string>>
}

/** A catalog of a server with memory (`true`), with the pacer but no memory (`false`), or a plain proxy. */
export const catalogOf = (
  memory: boolean | "no pacer",
  /**
   * `prompt`: whether the server answers prompts; `summary`: whether its start takes a summary; as the small server
   * says when left out.
   */
  options: { readonly prompt?: boolean; readonly summary?: boolean } = {},
): PacerModels.Catalog => ({
  at: 0,
  pacer:
    memory === "no pacer"
      ? null
      : {
          compactTokens: ["auto"],
          webTools: false,
          ...(memory
            ? {
                memory: {
                  version: 1,
                  entryCharacters: capabilities.entry_characters,
                  queryCharacters: capabilities.query_characters,
                  searchLimit: capabilities.search_limit,
                  embedding: null,
                  tasks: capabilities.tasks,
                  recalls: capabilities.recalls,
                  projects: capabilities.projects,
                  prompt: options.prompt ?? capabilities.prompt,
                  summary: options.summary ?? capabilities.summary,
                },
              }
            : {}),
        },
  models: [],
})

/**
 * The small memory server behind a proxy that keeps every request it gets, so a test can say what was sent (or that
 * nothing was). `answer` stands in for the server while set, and `hold` keeps answers until released.
 */
export function startProxied(options: { readonly embedding?: string } = {}) {
  const store = startMemoryServer({
    keys: [{ key, label: person }],
    ...(options.embedding ? { embedding: { url: options.embedding, model: "test-embedding" } } : {}),
  })
  const received: Received[] = []
  const releases: Array<() => void> = []
  const control = {
    answer: undefined as ((request: Received) => Response | Promise<Response>) | undefined,
    held: undefined as Promise<void> | undefined,
  }
  const proxy = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const text = await request.text()
      const item = {
        method: request.method,
        path: url.pathname,
        body: text ? JSON.parse(text) : undefined,
        pacer: Object.fromEntries([...request.headers].filter(([name]) => name.startsWith("x-pacer-"))),
      }
      received.push(item)
      if (control.held) await control.held
      if (control.answer) return control.answer(item)
      return fetch(`${store.url}${url.pathname}`, {
        method: request.method,
        headers: request.headers,
        ...(text ? { body: text } : {}),
      })
    },
  })
  const hold = () => {
    const gate = Promise.withResolvers<void>()
    control.held = gate.promise
    const release = () => {
      if (control.held === gate.promise) control.held = undefined
      gate.resolve()
    }
    releases.push(release)
    return release
  }
  /** Lets every held answer go and forgets any stand-in, as a test that shares the server starts. */
  const reset = () => {
    releases.splice(0).forEach((release) => release())
    control.answer = undefined
  }
  return {
    origin: `http://127.0.0.1:${proxy.port}`,
    store,
    proxy,
    received,
    control,
    hold,
    reset,
    /** The requests under `/pacer/v1/memory/`. */
    calls: () => received.filter((item) => item.path.startsWith("/pacer/v1/memory/")),
    stop: async () => {
      reset()
      await proxy.stop(true)
      await store.stop()
    },
  }
}

export const memoryServer = Effect.acquireRelease(Effect.sync(startProxied), (served) =>
  Effect.promise(() => served.stop()),
)
export type MemoryServer = Effect.Success<typeof memoryServer>

/** The same with the fake embedding endpoint behind the memory server, so that a write answers its `near` entries. */
export const nearServer = Effect.acquireRelease(
  Effect.sync(() => {
    const embedding = startFakeEmbedding()
    return { embedding, served: startProxied({ embedding: embedding.url }) }
  }),
  (both) => Effect.promise(() => both.served.stop().then(() => both.embedding.stop())),
).pipe(Effect.map((both) => both.served))

/** The memory client over the real PacerHttp, with the endpoint and the catalog in the test's hands. */
export const startClient = Effect.fnUntraced(function* (
  endpoint: PacerEndpoint.Endpoint | undefined,
  /** The catalog; `catalog: undefined` is one not read yet. A server with memory when left out. */
  options: { readonly catalog?: PacerModels.Catalog | undefined } = {},
) {
  const endpoints = yield* SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(endpoint)
  const catalogs = yield* SubscriptionRef.make<PacerModels.Catalog | undefined>(
    "catalog" in options ? options.catalog : catalogOf(true),
  )
  const endpointLayer = Layer.succeed(
    PacerEndpoint.Service,
    PacerEndpoint.Service.of({
      get: () => SubscriptionRef.get(endpoints),
      changes: () => SubscriptionRef.changes(endpoints),
    }),
  )
  const modelsLayer = Layer.succeed(
    PacerModels.Service,
    PacerModels.Service.of({
      get: () => SubscriptionRef.get(catalogs),
      changes: () => SubscriptionRef.changes(catalogs),
      refresh: () => Effect.void,
    }),
  )
  const context = yield* Layer.build(
    Layer.fresh(MemoryClient.layer).pipe(
      Layer.provide(
        Layer.fresh(PacerHttp.layer).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(endpointLayer)),
      ),
    ),
  )
  return {
    client: Context.get(context, MemoryClient.Service),
    endpoints,
    catalogs,
    endpointLayer,
    modelsLayer,
  }
})

export const endpointAt = (origin: string, apiKey = key) => endpointOf(origin, apiKey)
