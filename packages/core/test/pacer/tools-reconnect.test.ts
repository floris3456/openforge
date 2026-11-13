import { describe, expect } from "bun:test"
import { Context, Effect, Fiber, Layer, Logger, Option, Stream, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { SessionID } from "@opencode/schema/session-id"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerTools } from "@opencode/core/pacer/tools"
import { testEffect } from "../lib/effect"
import { endpointOf, ownerList } from "./fake-tools"

// A running service whose CPP stream closes and connects again: the connection reads the catalog again
// (`PacerConnection`'s `capabilities()`, i.e. `PacerModels.refresh`), with the same endpoint. Real PacerModels and
// PacerTools over one local CPP; no real model.

const capabilities = {
  pacer: { compact_tokens: ["auto"], web_tools: { tools: "/pacer/v1/tools" } },
  providers: [],
  models: [{ id: "claude-opus-5-5", routes: [{ provider: "claude", output: ["text"] }] }],
}

type Answer = () => Response | Promise<Response>

const serve = Effect.acquireRelease(
  Effect.sync(() => {
    const seen: string[] = []
    const gate = { held: false, opened: Promise.resolve(), release: () => {} }
    const answers: Record<string, Answer> = {
      "/v1/models": () => Response.json({ object: "list", data: [{ id: "claude-opus-5-5", object: "model" }] }),
      "/pacer/v1/capabilities": () => Response.json(capabilities),
      "/pacer/v1/models": () => Response.json({ models: [], manual: [], settings: [] }),
      "/pacer/v1/tools": () => Response.json(ownerList),
    }
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname
        seen.push(path)
        if (path === "/pacer/v1/tools" && gate.held) await gate.opened
        return answers[path]?.() ?? new Response("404 page not found", { status: 404 })
      },
    })
    const hold = () => {
      gate.held = true
      gate.opened = new Promise<void>((resolve) => {
        gate.release = () => {
          gate.held = false
          resolve()
        }
      })
    }
    return { origin: `http://127.0.0.1:${server.port}`, server, seen, answers, gate, hold }
  }),
  (cpp) => Effect.promise(() => cpp.server.stop(true)),
)

const start = Effect.fnUntraced(function* (origin: string) {
  const endpoints = yield* SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(endpointOf(origin))
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
  const http = Layer.fresh(PacerHttp.layer).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(endpointLayer))
  const models = Layer.fresh(PacerModels.layer).pipe(Layer.provide(http), Layer.provide(endpointLayer))
  const context = yield* Layer.build(
    Layer.mergeAll(
      models,
      Layer.fresh(PacerTools.layer).pipe(
        Layer.provide(Layer.mergeAll(http, endpointLayer, models, Layer.succeed(Bus.Service, bus))),
      ),
    ),
  )
  const catalogs = Context.get(context, PacerModels.Service)
  // The first catalog, as the service had it long before the reconnect.
  yield* catalogs.changes().pipe(
    Stream.filter((catalog) => catalog !== undefined),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.timeout("3 seconds"),
  )
  return { tools: Context.get(context, PacerTools.Service), catalogs }
})

const chat = SessionID.make("ses_web_tools_reconnect_chat")
const other = SessionID.make("ses_web_tools_reconnect_other")
const step = (sessionID: SessionID): PacerTools.ListInput => ({ sessionID, model: "claude-opus-5-5", step: true })
const lists = (seen: ReadonlyArray<string>) => seen.filter((path) => path === "/pacer/v1/tools").length

const it = testEffect(Layer.empty)

/** Runs `body` with every warning logged meanwhile in hand. */
const logged = <A, E, R>(body: (warnings: ReadonlyArray<unknown>) => Effect.Effect<A, E, R>) => {
  const warnings: unknown[] = []
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message)
  })
  return body(warnings).pipe(Effect.provide(Logger.layer([logger])))
}

describe("PacerTools across a reconnect of CPP's stream", () => {
  it.live("keeps every chat's list when the catalog is read again with the web tools, also during a list read", () =>
    logged((warnings) =>
      Effect.gen(function* () {
        const cpp = yield* serve
        const h = yield* start(cpp.origin)
        const held = yield* h.tools.list(step(chat))
        expect(held?.version).toBe(ownerList.version)

        // The chat's next step reads its list again (another version seen) while the reconnect reads the catalog.
        h.tools.seen(chat, "0123456789abcdef")
        cpp.hold()
        const reading = yield* h.tools.list(step(chat)).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.gen(function* () {
          while (lists(cpp.seen) < 2) yield* Effect.sleep("5 millis")
        }).pipe(Effect.timeout("3 seconds"))
        const before = yield* h.catalogs.get()
        yield* h.catalogs.refresh()
        expect(yield* h.catalogs.get()).not.toBe(before)
        expect((yield* h.catalogs.get())?.pacer?.webTools).toBe(true)
        // The same answers make the same models: CPP's provider is not rebuilt, and no provider.updated follows.
        expect((yield* h.catalogs.get())?.models).toEqual(before?.models)
        cpp.gate.release()
        expect((yield* Fiber.join(reading))?.version).toBe(ownerList.version)

        // And after it: the held list, and a first read for a chat that holds none.
        expect(yield* h.tools.list(step(chat))).toBe((yield* Fiber.join(reading))!)
        expect((yield* h.tools.list(step(other)))?.version).toBe(ownerList.version)
        expect(warnings).toEqual([])
      }),
    ),
  )

  it.live("leaves out every chat's tools, without a warning, when capabilities answer 429 on the reconnect", () =>
    logged((warnings) =>
      Effect.gen(function* () {
        const cpp = yield* serve
        const h = yield* start(cpp.origin)
        expect((yield* h.tools.list(step(chat)))?.version).toBe(ownerList.version)

        const before = yield* h.catalogs.get()
        // Any answer to capabilities but a 5xx or no answer is taken for a proxy without the pacer.
        cpp.answers["/pacer/v1/capabilities"] = () =>
          Response.json({ error: { type: "rate_limited", message: "slow down" } }, { status: 429 })
        yield* h.catalogs.refresh()
        expect((yield* h.catalogs.get())?.pacer).toBeNull()
        // Its models lose their routes' facts too, so CPP's provider is rebuilt (provider.updated, model.updated).
        expect((yield* h.catalogs.get())?.models).not.toEqual(before?.models)
        expect(yield* h.tools.list(step(chat))).toBeUndefined()
        expect(lists(cpp.seen)).toBe(1)
        expect(warnings).toEqual([])

        // Whereas a read that fails is logged, and keeps the catalog it had.
        cpp.answers["/v1/models"] = () => new Response("down", { status: 500 })
        yield* h.catalogs.refresh()
        expect(warnings.map((item) => (item as ReadonlyArray<unknown>)[0])).toEqual([
          "could not read CLIProxyPacer's models",
        ])
      }),
    ),
  )

  it.live("leaves out every chat's tools, without a warning, after one list read answered 404", () =>
    logged((warnings) =>
      Effect.gen(function* () {
        const cpp = yield* serve
        const h = yield* start(cpp.origin)
        expect((yield* h.tools.list(step(chat)))?.version).toBe(ownerList.version)

        cpp.answers["/pacer/v1/tools"] = () =>
          Response.json({ error: { type: "not_found", message: "no such chat" } }, { status: 404 })
        expect(yield* h.tools.list(step(other))).toBeUndefined()
        // The chat that holds its list loses it too, until the catalog changes; the reconnect's read changes it.
        expect(yield* h.tools.list(step(chat))).toBeUndefined()
        cpp.answers["/pacer/v1/tools"] = () => Response.json(ownerList)
        yield* h.catalogs.refresh()
        expect(warnings).toEqual([])
        const back = yield* h.tools.list(step(chat))
        expect(back?.version).toBe(ownerList.version)

        // Whereas a list read that fails is logged, and the chat keeps the list it holds.
        cpp.answers["/pacer/v1/tools"] = () => new Response("down", { status: 503 })
        h.tools.seen(chat, "0123456789abcdef")
        expect(yield* h.tools.list(step(chat))).toBe(back!)
        expect(warnings.map((item) => (item as ReadonlyArray<unknown>)[0])).toEqual([
          "could not read CLIProxyPacer's web tools",
        ])
      }),
    ),
  )
})
