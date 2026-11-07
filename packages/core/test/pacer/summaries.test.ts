import { describe, expect, test } from "bun:test"
import {
  AIError,
  CompactionPart,
  HttpContext,
  InvalidProviderOutputError,
  InvalidRequestError,
  Message,
  ProviderID,
  TransportError,
} from "@opencode/ai/effect"
import { Context, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import type { Pacer } from "@opencode/schema/pacer"
import type { SessionID } from "@opencode/schema/session-id"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { PacerStatus } from "@opencode/core/pacer/status"
import { PacerSummaries } from "@opencode/core/pacer/summaries"
import { testEffect } from "../lib/effect"

// Spec cliproxypacer-server-summaries, sections 2 and 3, and the interim warm/cold rule the lead set on 2026-11-07:
// who writes a summary of a chat on CLIProxyPacer, and how its answer is read. The fake CPP answers in CPP's shapes
// (pacer_sessions.rs, settings.rs) with synthetic data only.

const it = testEffect(Layer.empty)

describe("PacerSummaries, read", () => {
  test("X-Pacer-Compaction: warm or cold, the model that wrote it, the user messages kept", () => {
    expect(PacerSummaries.header("warm; model=gpt-6-luna; writer=server")).toEqual({
      cold: false,
      model: "gpt-6-luna",
      writer: "server",
    })
    expect(PacerSummaries.header("cold; model=claude-haiku-5-5; writer=server; user_messages=12")).toEqual({
      cold: true,
      model: "claude-haiku-5-5",
      writer: "server",
      userMessages: 12,
    })
    expect(PacerSummaries.header(" Cold ;model=m;user_messages=0")).toEqual({ cold: true, model: "m", userMessages: 0 })
    // Lost when a buffered answer had to send keep-alive bytes first (the guide), or not CPP's.
    for (const value of [undefined, "", "model=m", "lukewarm; model=m"])
      expect(PacerSummaries.header(value)).toBeUndefined()
    expect(PacerSummaries.header("warm; model=m; user_messages=many")).toEqual({ cold: false, model: "m" })
  })

  test("the summary is the readable user message's text after CLIProxyPacer's prefix; the compaction item is dropped", () => {
    const checkpoint = Message.assistant(
      CompactionPart.make({
        provider: ProviderID.make("cliproxypacer"),
        id: "cmp_1",
        encrypted: "cpa-ag-compact-v1:x",
      }),
    )
    const readable = Message.user("Context summary from previous turns:\nThe user asked for a plan.")
    expect(PacerSummaries.summaryOf([readable, checkpoint])).toBe("The user asked for a plan.")
    // An opaque capsule alone (`compaction.writer` unset on Claude), or text that is not CPP's summary, is none.
    expect(PacerSummaries.summaryOf([checkpoint])).toBeUndefined()
    expect(PacerSummaries.summaryOf([Message.user("Some other text"), checkpoint])).toBeUndefined()
    expect(
      PacerSummaries.summaryOf([Message.user("Context summary from previous turns:\n  \n"), checkpoint]),
    ).toBeUndefined()
    // The earlier user messages CPP keeps (`compaction.user_messages`) are part of its summary.
    const kept = "Summary.\n\n<earlier-user-messages>\n1. Plan a dark mode.\n</earlier-user-messages>"
    expect(PacerSummaries.summaryOf([Message.user(`Context summary from previous turns:\n${kept}`), checkpoint])).toBe(
      kept,
    )
  })

  test("why CLIProxyPacer couldn't write it, short", () => {
    const http = (status: number) =>
      new AIError({
        reason: new InvalidRequestError({
          message: "refused",
          http: new HttpContext({ url: "http://cpp.test/v1/responses/compact", status, headers: {} }),
        }),
      })
    expect(PacerSummaries.fallback(http(501))).toBe("it answered 501")
    expect(PacerSummaries.fallback(http(404))).toBe("it answered 404")
    expect(
      PacerSummaries.fallback(
        new AIError({
          reason: new InvalidProviderOutputError({ message: "Compaction response did not contain a checkpoint" }),
        }),
      ),
    ).toBe("no readable summary")
    expect(
      PacerSummaries.fallback(
        new AIError({
          reason: new TransportError({ message: "connection refused", transport: "http", operation: "request" }),
        }),
      ),
    ).toBe("it could not be reached")
    expect(PacerSummaries.fallback("timeout")).toBe("no answer in 4 minutes")
    expect(PacerSummaries.fallback("unreadable")).toBe("no readable summary")
  })
})

describe("PacerSummaries, warm or cold", () => {
  const own = "claude-e2e"
  test("a cold ask is cold; a move is warm unless its 409's models say the account ran out", () => {
    expect(PacerSummaries.warmth({ reason: "cold", models: [own] }, own)).toBe(false)
    // CLIENT-GUIDE 4.2: while the account has not run out and the chat is warm there, `models` starts with the chat's
    // own model; otherwise it is `routing.compaction_models` alone.
    expect(PacerSummaries.warmth({ reason: "move", models: ["Claude-E2E", "claude-e2e-mini"] }, own)).toBe(true)
    expect(PacerSummaries.warmth({ reason: "move", models: ["claude-e2e-mini", own] }, own)).toBe(false)
    expect(PacerSummaries.warmth({ reason: "move", models: [] }, own)).toBe(true)
    // Everything else: the chat's view.
    for (const reason of ["auto", "overflow", "manual"] as const)
      expect(PacerSummaries.warmth({ reason }, own)).toBe("view")
    expect(PacerSummaries.warmth({ reason: "manual", models: [own] }, own)).toBe("view")
  })

  test("by the view: warm, and warm until a time not past; no view is warm", () => {
    const now = 1_000_000
    expect(PacerSummaries.viewWarm(undefined, now)).toBe(true)
    expect(PacerSummaries.viewWarm({ warm: false }, now)).toBe(false)
    expect(PacerSummaries.viewWarm({ warm: true }, now)).toBe(true)
    expect(PacerSummaries.viewWarm({ warm: true, warmUntil: now + 1 }, now)).toBe(true)
    expect(PacerSummaries.viewWarm({ warm: true, warmUntil: now }, now)).toBe(false)
    expect(PacerSummaries.viewWarm({ warm: false, warmUntil: now + 60_000 }, now)).toBe(false)
  })

  test("the interim rule: only a Messages chat that is warm gets openforge's own summary", () => {
    expect(PacerSummaries.openforgeWhileWarm({ messages: true, warm: true })).toBe(true)
    expect(PacerSummaries.openforgeWhileWarm({ messages: true, warm: false })).toBe(false)
    expect(PacerSummaries.openforgeWhileWarm({ messages: false, warm: true })).toBe(false)
    expect(PacerSummaries.openforgeWhileWarm({ messages: false, warm: false })).toBe(false)
  })

  test("who writes: the chat's writer first, then the rule, then the route", () => {
    const decide = (input: Partial<Parameters<typeof PacerSummaries.decide>[0]>) =>
      PacerSummaries.decide({ writer: "server", writes: true, messages: false, warm: true, ...input })
    expect(decide({})).toEqual({ by: "cliproxypacer" })
    expect(decide({ writer: undefined })).toEqual({ by: "cliproxypacer" })
    expect(decide({ writer: "client" })).toEqual({ by: "openforge" })
    expect(decide({ writer: "client", writes: false })).toEqual({ by: "openforge" })
    expect(decide({ messages: true })).toEqual({ by: "openforge" })
    expect(decide({ messages: true, warm: false })).toEqual({ by: "cliproxypacer" })
    expect(decide({ writes: false })).toEqual({
      by: "openforge",
      fallback: "it writes no summaries on this model's route",
    })
    expect(decide({ writes: false, messages: true })).toEqual({ by: "openforge" })
  })
})

type Json = Record<string, unknown>

interface Cpp {
  readonly origin: string
  readonly seen: Array<{ readonly method: string; readonly path: string; readonly body: unknown }>
  /** The chats' views, each with its own settings; `effective` is worked out when answered. */
  readonly views: Map<string, Json>
  /** `compaction.writer` at the key's own level, and at the server's. */
  keyWriter: string | null
  serverWriter: string | null
  /** Every answer to these paths: this status. */
  readonly failing: Map<string, number>
}

const fakeCpp = Effect.acquireRelease(
  Effect.sync(() => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url)
        const path = url.pathname
        const text = request.method === "GET" ? "" : await request.text()
        const body = text ? JSON.parse(text) : undefined
        cpp.seen.push({ method: request.method, path, body })
        const failing = cpp.failing.get(`${request.method} ${path}`)
        if (failing) return Response.json({ error: { type: "internal", message: "synthetic" } }, { status: failing })
        // A setting resolves session, key, server, default (settings.rs); a view says how it applies to the chat.
        const answer = (view: Json) => {
          const own = (view.settings as Json | undefined)?.["compaction.writer"]
          return Response.json({
            ...view,
            effective: { compaction_writer: own ?? cpp.keyWriter ?? cpp.serverWriter ?? null },
          })
        }
        const session = path.match(/^\/pacer\/v1\/sessions\/([^/]+)$/)?.[1]
        if (session) {
          const view = cpp.views.get(session)
          if (request.method === "PATCH") {
            // A PATCH writes the chat's own settings, a new chat's too, and answers its view (pacer_sessions.rs).
            const next = { ...(view ?? { id: session }), settings: { ...(view?.settings as Json), ...(body as Json) } }
            cpp.views.set(session, next)
            return answer(next)
          }
          return view
            ? answer(view)
            : Response.json({ error: { type: "not_found", message: "no such session" } }, { status: 404 })
        }
        if (path === "/pacer/v1/settings")
          return Response.json([
            {
              name: "compaction.writer",
              default: null,
              server: cpp.serverWriter,
              key: cpp.keyWriter,
              value: cpp.keyWriter ?? cpp.serverWriter ?? null,
            },
          ])
        return Response.json({ error: { type: "not_found", message: "no route" } }, { status: 404 })
      },
    })
    const cpp: Cpp = {
      origin: `http://127.0.0.1:${server.port}`,
      seen: [],
      views: new Map(),
      keyWriter: null,
      serverWriter: null,
      failing: new Map(),
    }
    return { cpp, server }
  }),
  ({ server }) => Effect.promise(() => server.stop(true)),
).pipe(Effect.map(({ cpp }) => cpp))

const catalog: PacerModels.Catalog = {
  at: 0,
  pacer: { compactTokens: ["auto", "cold", "before-cold"], webTools: false },
  models: [
    { id: "claude-e2e", summaries: [{ provider: "claude", writes: true }] },
    { id: "kimi-e2e", summaries: [{ provider: "kimi", writes: true }] },
    { id: "gpt-e2e", summaries: [{ provider: "codex", writes: false }] },
  ],
}

const start = Effect.fnUntraced(function* () {
  const cpp = yield* fakeCpp
  const endpoint = PacerEndpoint.resolve({ baseURL: `${cpp.origin}/v1`, apiKey: "test-key" }, undefined)
  const context = yield* Layer.build(
    PacerSummaries.layer.pipe(
      Layer.provideMerge(PacerStatus.layer),
      Layer.provide(PacerHttp.layer),
      Layer.provide(
        Layer.succeed(
          PacerEndpoint.Service,
          PacerEndpoint.Service.of({
            get: () => Effect.succeed(endpoint),
            changes: () => Effect.die("unused") as never,
          }),
        ),
      ),
      Layer.provide(
        Layer.succeed(
          PacerModels.Service,
          PacerModels.Service.of({
            get: () => Effect.succeed(catalog),
            changes: () => Effect.die("unused") as never,
            refresh: () => Effect.void,
          }),
        ),
      ),
      Layer.provide(FetchHttpClient.layer),
    ),
  )
  const status = Context.get(context, PacerStatus.Service)
  /** The connection's state, as the connection would set it. */
  const state = (next: Pacer.State) => status.set({ state: next, since: 0, refused: false })
  yield* state("on")
  return { cpp, summaries: Context.get(context, PacerSummaries.Service), state }
})

const sessionID = "ses_summaries_test_chat_000000000000000000000000000000000000000000000000000000000000000" as SessionID
const uuid = PacerSessionID.make(sessionID)
/** The chat's view at CPP, holding `own` as its own `compaction.writer` (none when null). */
const view = (own: string | null, warm: Json = { warm: true }) => ({
  id: uuid,
  session_id: 7,
  provider: "kimi",
  model: "kimi-e2e",
  settings: own === null ? {} : { "compaction.writer": own },
  ...warm,
})
const plan = (input: Partial<PacerSummaries.PlanInput>) => ({
  sessionID,
  model: "kimi-e2e",
  messages: false,
  warm: "view" as const,
  ...input,
})

describe("PacerSummaries.plan", () => {
  // The key level decides, as the Settings row shows it, so a choice there reaches every chat (the lead's fix of
  // 2026-11-07): a chat's own `server`, which openforge sets, never outvotes the key's `client`.
  it.live("follows the key level as Settings shows it: its `client` is openforge's, whatever the chat's own says", () =>
    Effect.gen(function* () {
      const { cpp, summaries } = yield* start()
      const writes = () => cpp.seen.filter((item) => item.method === "PATCH")
      // The key's own `client`, the chat's own `server`.
      cpp.keyWriter = "client"
      cpp.views.set(uuid, view("server"))
      expect(yield* summaries.plan(plan({}))).toEqual({ by: "openforge" })
      // The key's own unset, the server's `client`: the key level is `client` all the same.
      cpp.keyWriter = null
      cpp.serverWriter = "client"
      expect(yield* summaries.plan(plan({}))).toEqual({ by: "openforge" })
      expect(writes()).toEqual([])
      expect(cpp.seen.filter((item) => item.path === "/pacer/v1/settings")).toHaveLength(2)
    }),
  )

  it.live("a chat's own `client`, set by someone else, is openforge's too", () =>
    Effect.gen(function* () {
      const { cpp, summaries } = yield* start()
      cpp.views.set(uuid, view("client"))
      expect(yield* summaries.plan(plan({}))).toEqual({ by: "openforge" })
      cpp.keyWriter = "server"
      expect(yield* summaries.plan(plan({}))).toEqual({ by: "openforge" })
      expect(cpp.seen.filter((item) => item.method === "PATCH")).toEqual([])
    }),
  )

  it.live("the key level unset or `server`: CPP's, setting the chat's own `server` once where it isn't already", () =>
    Effect.gen(function* () {
      const { cpp, summaries } = yield* start()
      const writes = () => cpp.seen.filter((item) => item.method === "PATCH")
      // Unset everywhere: the one PATCH, so CPP's answer is readable.
      cpp.views.set(uuid, view(null))
      expect(yield* summaries.plan(plan({}))).toEqual({ by: "cliproxypacer" })
      expect(writes()).toEqual([
        { method: "PATCH", path: `/pacer/v1/sessions/${uuid}`, body: { "compaction.writer": "server" } },
      ])
      // Its own `server` now applies: no second write.
      expect(yield* summaries.plan(plan({}))).toEqual({ by: "cliproxypacer" })
      expect(writes()).toHaveLength(1)
      // The key's `server` applies to a chat without its own: nothing to write.
      cpp.keyWriter = "server"
      cpp.views.set(uuid, view(null))
      expect(yield* summaries.plan(plan({}))).toEqual({ by: "cliproxypacer" })
      expect(writes()).toHaveLength(1)
    }),
  )

  it.live("a chat CPP knows nothing of follows the key's writer; unset, it gets its own `server`", () =>
    Effect.gen(function* () {
      const { cpp, summaries } = yield* start()
      cpp.keyWriter = "client"
      expect(yield* summaries.plan(plan({}))).toEqual({ by: "openforge" })
      expect(cpp.seen.map((item) => `${item.method} ${item.path}`)).toEqual([
        `GET /pacer/v1/sessions/${uuid}`,
        "GET /pacer/v1/settings",
      ])
      cpp.keyWriter = null
      expect(yield* summaries.plan(plan({}))).toEqual({ by: "cliproxypacer" })
      expect(cpp.seen.at(-1)).toEqual({
        method: "PATCH",
        path: `/pacer/v1/sessions/${uuid}`,
        body: { "compaction.writer": "server" },
      })
    }),
  )

  it.live("the interim rule: a Messages chat warm by its view or its move gets openforge's own, cold CPP's", () =>
    Effect.gen(function* () {
      const { cpp, summaries } = yield* start()
      const claude = { model: "claude-e2e", messages: true }
      cpp.views.set(uuid, view("server", { warm: true, warm_until: Date.now() + 60_000 }))
      expect(yield* summaries.plan(plan(claude))).toEqual({ by: "openforge" })
      expect(yield* summaries.plan(plan({ ...claude, warm: true }))).toEqual({ by: "openforge" })
      expect(yield* summaries.plan(plan({ ...claude, warm: false }))).toEqual({ by: "cliproxypacer" })
      // Warm by the flag, but its time is past: cold.
      cpp.views.set(uuid, view("server", { warm: true, warm_until: Date.now() - 60_000 }))
      expect(yield* summaries.plan(plan(claude))).toEqual({ by: "cliproxypacer" })
      cpp.views.set(uuid, view("server", { warm: false }))
      expect(yield* summaries.plan(plan(claude))).toEqual({ by: "cliproxypacer" })
      // A Responses chat, warm or cold: CPP's.
      cpp.views.set(uuid, view("server", { warm: true, warm_until: Date.now() + 60_000 }))
      expect(yield* summaries.plan(plan({}))).toEqual({ by: "cliproxypacer" })
      // An unset writer is set only when CPP is to write.
      cpp.views.set(uuid, view(null, { warm: true, warm_until: Date.now() + 60_000 }))
      expect(yield* summaries.plan(plan(claude))).toEqual({ by: "openforge" })
      expect(cpp.seen.filter((item) => item.method === "PATCH")).toEqual([])
    }),
  )

  it.live("only on routes where CPP writes with writer server; elsewhere openforge, saying why", () =>
    Effect.gen(function* () {
      const { cpp, summaries } = yield* start()
      cpp.views.set(uuid, view(null))
      expect(yield* summaries.plan(plan({ model: "gpt-e2e" }))).toEqual({
        by: "openforge",
        fallback: "it writes no summaries on this model's route",
      })
      expect(yield* summaries.plan(plan({ model: "not-listed" }))).toEqual({
        by: "openforge",
        fallback: "it writes no summaries on this model's route",
      })
      expect(cpp.seen.filter((item) => item.method === "PATCH")).toEqual([])
    }),
  )

  // Only while the connection is on (the lead's fix of 2026-11-07): a plain proxy answered every compaction's reads with
  // 404 first, and the record said CLIProxyPacer couldn't.
  it.live("asks CPP only while the connection is on: without a pacer no one is named, unreachable says so", () =>
    Effect.gen(function* () {
      const { cpp, summaries, state } = yield* start()
      cpp.views.set(uuid, view(null))
      for (const next of ["no-pacer", "unset"] as const) {
        yield* state(next)
        expect(yield* summaries.plan(plan({}))).toBeUndefined()
      }
      yield* state("unreachable")
      expect(yield* summaries.plan(plan({}))).toEqual({ by: "openforge", fallback: "unreachable" })
      expect(cpp.seen).toEqual([])
      yield* state("on")
      expect(yield* summaries.plan(plan({}))).toEqual({ by: "cliproxypacer" })
      expect(cpp.seen.map((item) => `${item.method} ${item.path}`)).toEqual([
        `GET /pacer/v1/sessions/${uuid}`,
        "GET /pacer/v1/settings",
        `PATCH /pacer/v1/sessions/${uuid}`,
      ])
    }),
  )

  it.live("CPP unreachable, or the writer not set: openforge writes, saying so", () =>
    Effect.gen(function* () {
      const { cpp, summaries } = yield* start()
      cpp.failing.set(`GET /pacer/v1/sessions/${uuid}`, 503)
      expect(yield* summaries.plan(plan({}))).toEqual({ by: "openforge", fallback: "unreachable" })
      cpp.failing.clear()
      cpp.views.set(uuid, view(null))
      cpp.failing.set(`PATCH /pacer/v1/sessions/${uuid}`, 400)
      expect(yield* summaries.plan(plan({}))).toEqual({
        by: "openforge",
        fallback: "the chat's writer could not be set",
      })
    }),
  )
})
