import { Context, Effect, Layer, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { SessionID } from "@opencode/schema/session-id"
import { Bus } from "@opencode/core/bus"
import { Environment } from "@opencode/core/environment/index"
import { FileAccess } from "@opencode/core/file-access"
import { MemoryClient } from "@opencode/core/memory/client"
import { MemoryHandIn } from "@opencode/core/memory/hand-in"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHeaders } from "@opencode/core/pacer/headers"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerProject } from "@opencode/core/pacer/project"
import { PacerTools } from "@opencode/core/pacer/tools"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionStore } from "@opencode/core/session/store"
import { Tool } from "@opencode/core/tool"
import { PacerToolsPlugin } from "@opencode/core/tool/plugin/pacer-tools"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { registerToolPlugin, toolDefinitions } from "../lib/tool"
import { capabilities, startMemoryServer } from "../pacer/memory-server"
import { endpointOf } from "../pacer/fake-tools"
import { startFakeEmbedding } from "../pacer/memory-embedding"

export const key = "memory-client-key-f1"
export const person = "floris"

/** What the proxy in front of the memory server got: the request as sent, before the server answers. */
export interface Received {
  readonly method: string
  readonly path: string
  /** The query, with its `?`, or empty. */
  readonly search: string
  readonly body: unknown
  /** CPP's own headers it got (`x-pacer-*`), by their lower-case names. */
  readonly pacer: Readonly<Record<string, string>>
}

/** A catalog of a server with memory (`true`), with the pacer but no memory (`false`), or a plain proxy. */
export const catalogOf = (
  memory: boolean | "no pacer",
  /**
   * `prompt`: whether the server answers prompts; `summary`: whether its start takes a summary; `plans`: whether its
   * tasks are plans; `tools`: whether it serves the memory tools and memory's texts; as the small server says when
   * left out; `goals`: whether it has goals; `later`: whether it has the task system's later items; `reviewItems`:
   * whether it has agents' notes on review items (`image.show({ task, item })`); `stepItems`: whether a step takes items
   * and holds rounds of its own; `reviewOwed`: whether it says what a lead owes its helper's rounds (`GET …/owed`);
   * `inspect`: whether it has the reads of
   * other projects (`openforge cpp`); `identities`: whether it keeps agents' identities (`/identity`); `badges`: whether
   * it gives each chat's agent's badge (coloured titles, workspace spec agent-badges 3.3); `codemode`: the
   * tools its capabilities say run in Code Mode (`tools.task_codemode`), whose list keeps them direct otherwise.
   */
  options: {
    readonly prompt?: boolean
    readonly summary?: boolean
    readonly plans?: boolean
    readonly tools?: boolean
    readonly goals?: boolean
    readonly later?: boolean
    readonly reviewItems?: boolean
    readonly stepItems?: boolean
    readonly reviewOwed?: boolean
    readonly inspect?: boolean
    readonly identities?: boolean
    readonly badges?: boolean
    readonly codemode?: ReadonlyArray<string>
  } = {},
): PacerModels.Catalog => ({
  at: 0,
  pacer:
    memory === "no pacer"
      ? null
      : {
          compactTokens: ["auto"],
          webTools: false,
          ...(options.codemode === undefined
            ? {}
            : {
                tools: new Map(
                  options.codemode.map((name) => [
                    name,
                    { title: name, permission: name, subject: [], read_only: false, codemode: true },
                  ]),
                ),
              }),
          ...(memory
            ? {
                memory: {
                  version: 1,
                  entryCharacters: capabilities.entry_characters,
                  queryCharacters: capabilities.query_characters,
                  searchLimit: capabilities.search_limit,
                  embedding: null,
                  tasks: capabilities.tasks,
                  plans: options.plans ?? capabilities.plans,
                  recalls: capabilities.recalls,
                  projects: capabilities.projects,
                  prompt: options.prompt ?? capabilities.prompt,
                  summary: options.summary ?? capabilities.summary,
                  tools: options.tools ?? capabilities.tools,
                  goals: options.goals ?? false,
                  later: options.later ?? false,
                  reviewItems: options.reviewItems ?? false,
                  stepItems: options.stepItems ?? false,
                  reviewOwed: options.reviewOwed ?? false,
                  inspect: options.inspect ?? false,
                  identities: options.identities ?? false,
                  badges: options.badges ?? false,
                  news: false,
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
        search: url.search,
        body: text ? JSON.parse(text) : undefined,
        pacer: Object.fromEntries([...request.headers].filter(([name]) => name.startsWith("x-pacer-"))),
      }
      received.push(item)
      if (control.held) await control.held
      if (control.answer) return control.answer(item)
      return fetch(`${store.url}${url.pathname}${url.search}`, {
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
  /** The server's own answer to a request the proxy got, for a stand-in that answers only some itself. */
  const pass = (request: Received) =>
    fetch(`${store.url}${request.path}${request.search}`, {
      method: request.method,
      headers: { ...request.pacer, authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    })
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
    pass,
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

/**
 * CPP's tools as openforge registers them, in a runner's graph: their calls read the chat from the store, and CPP's
 * place goes into its metadata as the session's own `setMetadata` puts it.
 */
export const pacerToolsNode = (name: string) =>
  makeLocationNode({
    name,
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const store = yield* SessionStore.Service
        const bus = yield* Bus.Service
        yield* registerToolPlugin(PacerToolsPlugin.Plugin).pipe(
          Effect.provide(
            Layer.mock(Session.Service, {
              get: (sessionID) =>
                store
                  .get(sessionID)
                  .pipe(
                    Effect.flatMap((found) =>
                      found ? Effect.succeed(found) : Effect.fail(new Session.NotFoundError({ sessionID })),
                    ),
                  ),
              setMetadata: (input) => bus.publish(SessionEvent.MetadataUpdated, input).pipe(Effect.asVoid),
              revert: {
                stage: () => Effect.die("unused"),
                clear: () => Effect.die("unused"),
                commit: () => Effect.die("unused"),
              },
            }),
          ),
        )
      }),
    ),
    deps: [
      Tool.node,
      Permission.node,
      PacerTools.node,
      PacerProject.node,
      FileAccess.node,
      Environment.node,
      MemoryHandIn.node,
      SessionStore.node,
      Bus.node,
    ],
  })

/**
 * What an earlier chat of this openforge did once at the endpoint: read a list that named the memory tools, so they
 * are registered before the test's chat steps. A chat of `project`, which has memory on the small server.
 */
export const primeTools = (project: string) =>
  Effect.gen(function* () {
    const tools = yield* PacerTools.Service
    const registry = yield* Tool.Service
    yield* tools.list({
      sessionID: SessionID.make(`ses_prime_${crypto.randomUUID().slice(0, 8)}`),
      project: PacerHeaders.project(project, { name: "project" }),
      model: "fake-model",
      agent: "build",
      codemode: true,
      step: true,
      continues: false,
    })
    yield* poll(
      "the memory tools are registered",
      () =>
        Effect.runSync(
          toolDefinitions(registry).pipe(Effect.map((items) => items.some((item) => item.name === "task"))),
        ) || codeModeRoots(registry).includes("task"),
    )
  })

/**
 * The proxy's answers with the list's meta saying the named tools run in Code Mode, as a server with
 * `tools.task_codemode` does: a list read's meta is learnt too, so a capabilities read alone would be undone.
 */
export const codeModeList =
  (served: ReturnType<typeof startProxied>, names: ReadonlyArray<string>) =>
  async (request: Received): Promise<Response> => {
    const response = await served.pass(request)
    if (request.method !== "GET" || request.path !== "/pacer/v1/tools") return response
    const body = (await response.json()) as { meta?: Record<string, Record<string, unknown>> }
    return Response.json({
      ...body,
      meta: Object.fromEntries(
        Object.entries(body.meta ?? {}).map(([name, meta]) => [
          name,
          names.includes(name) ? { ...meta, codemode: true } : meta,
        ]),
      ),
    })
  }

/**
 * The Code Mode catalog's top-level tools, as the step's snapshot has them: a tool in a namespace (`x.task`) is its
 * namespace's, not one of these.
 */
export const codeModeRoots = (registry: Tool.Interface) =>
  Effect.runSync(
    registry
      .snapshot([])
      .pipe(
        Effect.map((set) =>
          (set.codeModeCatalog?.tools ?? []).flatMap((entry) => (entry.type === "tool" ? [entry.name] : [])),
        ),
      ),
  )

/** Waits, in real time whatever the test's clock and at most 5 s, until `check` holds. */
export const poll = (label: string, check: () => boolean) =>
  Effect.gen(function* () {
    const deadline = performance.now() + 5_000
    while (!check()) {
      if (performance.now() > deadline) return yield* Effect.die(new Error(`never happened: ${label}`))
      yield* Effect.promise(() => Bun.sleep(5))
    }
  })
