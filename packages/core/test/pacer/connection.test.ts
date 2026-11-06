import { describe, expect } from "bun:test"
import { Clock, Context, Effect, Layer, Stream, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Pacer } from "@opencode/schema/pacer"
import { Provider } from "@opencode/schema/provider"
import type { SessionID } from "@opencode/schema/session-id"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { PacerConnection } from "@opencode/core/pacer/connection"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { globalProjectNode } from "../lib/project"

// A fake CPP on 127.0.0.1 port 0 that answers in CPP's shapes (crates/cpa-server/src/pacer_sessions.rs, pacer_api.rs,
// crates/cpa-pacer/src/monitor.rs) with synthetic data only: no real account, alias, ID, count or price. The connection
// runs on TestClock; the fake reads the same clock for its `Date` header and the times it records.

const it = testEffect(Layer.empty)
const encoder = new TextEncoder()

type Json = Record<string, unknown>

interface Seen {
  readonly method: string
  readonly path: string
  readonly query: URLSearchParams
  readonly body: unknown
  /** The test clock when it arrived. */
  readonly at: number
}

/** CPP's synthetic answers; a test changes them as it goes. */
interface Cpp {
  readonly origin: string
  readonly seen: Seen[]
  /** CPP's clock minus the service's, as its `Date` header says. */
  offset: number
  /** Every answer: a status other than 200 (with `Retry-After` when set), or a plain 404 of a proxy without CPP. */
  failure: { readonly status: number; readonly type?: string; readonly retryAfter?: number } | "plain" | undefined
  readonly views: Map<string, Json>
  listed: Json[]
  meters: Json[]
  rows: Json[]
  readonly prompts: Map<string, Json>
  /** The stream sends nothing before the first heartbeat, so its headers come only then, as through a proxy that holds
   * them until the first bytes. */
  quiet: boolean
  /** Path prefixes whose answers wait until `release`. */
  readonly holds: Set<string>
  readonly release: () => void
  /** View reads in flight now, and at most. */
  readonly inflight: { now: number; most: number }
  /** Open change streams. */
  readonly streams: () => number
  readonly notice: (event: string, data: Json) => void
  readonly heartbeat: () => void
  readonly end: () => void
  /** CPP's clock now. */
  readonly time: () => number
}

const fakeCpp = (now: () => number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>()
      const waiting: Array<() => void> = []
      const time = () => now() + cpp.offset
      const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        Response.json(body, { status, headers: { date: new Date(time()).toUTCString(), ...headers } })
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        idleTimeout: 0,
        fetch: async (request) => {
          const url = new URL(request.url)
          const path = url.pathname
          const text = request.method === "GET" ? "" : await request.text()
          cpp.seen.push({
            method: request.method,
            path,
            query: url.searchParams,
            body: text ? JSON.parse(text) : undefined,
            at: now(),
          })
          // Decided as the request arrives, answered after any hold: a slow answer says what was so when asked.
          const failure = cpp.failure
          const view = path.match(/^\/pacer\/v1\/sessions\/([^/]+)$/)?.[1]
          const counted = failure === undefined && view !== undefined && request.method === "GET"
          if (counted) cpp.inflight.most = Math.max(cpp.inflight.most, ++cpp.inflight.now)
          if ([...cpp.holds].some((prefix) => path.startsWith(prefix)))
            await new Promise<void>((resolve) => waiting.push(resolve))
          if (counted) cpp.inflight.now--
          if (failure === "plain") return new Response("404 page not found", { status: 404 })
          if (failure)
            return answer(
              { error: { type: failure.type ?? "internal", message: `synthetic ${failure.status}` } },
              failure.status,
              failure.retryAfter ? { "retry-after": String(failure.retryAfter) } : {},
            )
          return route(request.method, path, url.searchParams, text ? JSON.parse(text) : undefined)
        },
      })
      const route = (method: string, path: string, query: URLSearchParams, body: unknown): Response => {
        if (path === "/pacer/v1/stream") {
          const opened: { controller?: ReadableStreamDefaultController<Uint8Array> } = {}
          return new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => {
                opened.controller = controller
                controllers.add(controller)
                // Bun's server sends a streamed answer's headers with its first bytes; CPP's sends them at once.
                if (!cpp.quiet) controller.enqueue(encoder.encode(":open\n\n"))
              },
              // The client went away.
              cancel: () => void (opened.controller && controllers.delete(opened.controller)),
            }),
            { headers: { "content-type": "text/event-stream", date: new Date(time()).toUTCString() } },
          )
        }
        if (path === "/pacer/v1/state")
          return answer({
            key: { id: 1, hint: "test", label: null },
            settings: [],
            registry: [],
            meters: cpp.meters,
            sessions: { items: [], next: null },
            live: {},
            next: [],
          })
        if (path === "/pacer/v1/meters") return answer(cpp.meters)
        if (path === "/pacer/v1/sessions") return answer({ items: cpp.listed })
        const events = path.match(/^\/pacer\/v1\/sessions\/([^/]+)\/events$/)?.[1]
        if (events && method === "POST") {
          const type = (body as Json).type
          return answer({ id: events, type, pings_stopped: type !== "label" })
        }
        const session = path.match(/^\/pacer\/v1\/sessions\/([^/]+)$/)?.[1]
        if (session && method === "PATCH") {
          const view = cpp.views.get(session) ?? chatView(session, time())
          const settings = { ...(view.settings as Json), ...(body as Json) }
          const effective = { ...(view.effective as Json) }
          if ("pings.enabled" in settings && settings["pings.enabled"] !== null)
            effective.pings_enabled = settings["pings.enabled"]
          if ("warming.compact_before_cold" in settings && settings["warming.compact_before_cold"] !== null)
            effective.compact_before_cold = settings["warming.compact_before_cold"]
          const next = { ...view, settings, effective }
          cpp.views.set(session, next)
          return answer(next)
        }
        if (session) {
          const view = cpp.views.get(session)
          return view ? answer(view) : answer({ error: { type: "not_found", message: "no such session" } }, 404)
        }
        if (path === "/pacer/v1/monitor/requests") return answer(requests(query))
        const prompt = path.match(/^\/pacer\/v1\/prompts\/([^/]+)$/)?.[1]
        if (prompt) {
          const found = cpp.prompts.get(prompt)
          return found ? answer(found) : answer({ error: { type: "not_found", message: "no prompt" } }, 404)
        }
        return answer({ error: { type: "not_found", message: "no route" } }, 404)
      }
      // Newest first, as CPP lists them.
      const requests = (query: URLSearchParams) => {
        const all = cpp.rows.toSorted((a, b) => Number(b.id) - Number(a.id))
        const one = query.get("request")
        if (one) return { usage: {}, items: all.filter((row) => row.ext === one || String(row.id) === one), next: null }
        const after = query.get("after")
        const session = query.get("session")
        const verdicts = query.get("verdict")?.split(",")
        const cursor = query.get("cursor")
        const limit = Number(query.get("limit") ?? 50)
        const picked = all.filter(
          (row) =>
            (after === null || Number(row.id) > Number(after)) &&
            (session === null || String(row.session_id) === session || String(row.root_id) === session) &&
            (verdicts === undefined || verdicts.includes(String(row.cache_verdict))) &&
            (cursor === null || Number(row.id) < Number(cursor.split(".")[1])),
        )
        const page = picked.slice(0, limit)
        const last = page.at(-1)
        return {
          usage: {},
          items: page,
          next: picked.length > limit && last ? `${last.at}.${last.id}` : null,
        }
      }
      const cpp: Cpp = {
        origin: `http://127.0.0.1:${server.port}`,
        seen: [],
        offset: 0,
        failure: undefined,
        quiet: false,
        views: new Map(),
        listed: [],
        meters: [],
        rows: [],
        prompts: new Map(),
        holds: new Set(),
        release: () => {
          cpp.holds.clear()
          for (const resolve of waiting.splice(0)) resolve()
        },
        inflight: { now: 0, most: 0 },
        streams: () => controllers.size,
        notice: (event, data) => {
          for (const controller of controllers)
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ kind: event, ...data })}\n\n`))
        },
        heartbeat: () => {
          for (const controller of controllers) controller.enqueue(encoder.encode(":heartbeat\n\n"))
        },
        end: () => {
          for (const controller of controllers) controller.close()
          controllers.clear()
        },
        time,
      }
      return { cpp, server }
    }),
    (served) =>
      Effect.promise(async () => {
        served.cpp.release()
        served.cpp.end()
        await served.server.stop(true)
      }),
  ).pipe(Effect.map((served) => served.cpp))

/** A chat's view as CPP answers it, warm with pings planned. */
function chatView(uuid: string, now: number, fields: Json = {}): Json {
  return {
    id: uuid,
    session_id: 7,
    key_id: 1,
    account: "auth-a",
    provider: "prova",
    generation: 1,
    model: "model-a",
    warm: true,
    warm_until: now + 300_000,
    pings: {
      active: true,
      next_ping_at: now + 240_000,
      pings_left: 3,
      pings_sent: 0,
      interval_ms: 240_000,
      since: now,
      stopped: null,
    },
    settings: { "pings.enabled": null, "pings.duration_minutes": null, "cache.class": null, model: null },
    effective: { pings_enabled: true, compact_before_cold: false },
    warming: { cold: false, size_tokens: 1_000, threshold: 70_000, compact_at: null, compact_reason: null },
    next_use: { credential: "account-b", reason: "cold_move", window_values: [] },
    force_use: null,
    label: null,
    ...fields,
  }
}

function meter(now: number, fields: Json = {}): Json {
  return {
    auth_index: "auth-a",
    provider: "prova",
    label: "account-a",
    plan: "plan-a",
    windows: [
      {
        provider: "prova",
        scope: "all",
        seconds: 18_000,
        left: 62,
        reset: now + 4_800_000,
        reset_quality: "absolute",
        usage_at: now - 60_000,
        label: "5h",
        state: "current",
        not_applicable: false,
      },
    ],
    ...fields,
  }
}

function row(id: number, fields: Json = {}): Json {
  return {
    id,
    at: 1_000_000 + id,
    ext: `req-${id}`,
    key_id: 1,
    session_id: 7,
    provider: "prova",
    model: "upstream-a",
    alias: "model-a",
    kind: 0,
    status: 200,
    failed: false,
    input: 10,
    output: 5,
    reasoning: 0,
    cache_read: 100,
    cache_write_5m: 20,
    cache_write_1h: 0,
    cache_write_other: 0,
    cost_api: 1_500,
    cache_verdict: "hit",
    cache_cause: null,
    cache_shortfall: 0,
    miss_cost: null,
    changed_part: null,
    cache_base: null,
    refusal: null,
    session_ext: null,
    subagent: false,
    account: "account-a",
    ...fields,
  }
}

const catalog = (at: number, pacer = true): PacerModels.Catalog => ({
  at,
  pacer: pacer ? { compactTokens: ["auto", "before-cold"] } : null,
  models: [],
})

interface Harness {
  readonly cpp: Cpp
  /** A folder of its own, where the test's chats are. */
  readonly location: Location.Ref
  readonly connection: PacerConnection.Interface
  readonly bus: Bus.Interface
  readonly sessions: Session.Interface
  /** Queues input for the chat without running it. */
  readonly enqueue: (sessionID: SessionID) => Effect.Effect<unknown>
  readonly endpoint: SubscriptionRef.SubscriptionRef<PacerEndpoint.Endpoint | undefined>
  readonly catalog: SubscriptionRef.SubscriptionRef<PacerModels.Catalog | undefined>
  readonly refreshes: { count: number }
  readonly execution: { readonly active: Set<SessionID>; readonly woken: SessionID[] }
  /** Every `pacer.*` event published since the harness started. */
  readonly published: Array<{ readonly type: string; readonly data: unknown }>
  /** Every `Session.get` since the harness started: the session store's reads. */
  readonly lookups: { count: number }
  readonly connect: (key?: string) => Effect.Effect<void>
}

/** The connection over the real Bus and Session store, with CPP's endpoint and catalog in the test's hands. */
const harness = Effect.fnUntraced(function* () {
  const clock = yield* TestClock.testClockWith(Effect.succeed)
  const cpp = yield* fakeCpp(() => clock.currentTimeMillisUnsafe())
  const folder = yield* tmpdirScoped("opencode-pacer-connection-")
  const endpoint = yield* SubscriptionRef.make<PacerEndpoint.Endpoint | undefined>(undefined)
  const models = yield* SubscriptionRef.make<PacerModels.Catalog | undefined>(catalog(0))
  const refreshes = { count: 0 }
  const lookups = { count: 0 }
  const execution = { active: new Set<SessionID>(), woken: [] as SessionID[] }
  const endpoints = Layer.succeed(
    PacerEndpoint.Service,
    PacerEndpoint.Service.of({
      get: () => SubscriptionRef.get(endpoint),
      changes: () => SubscriptionRef.changes(endpoint),
    }),
  )
  const context = yield* Layer.build(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        SessionProjector.node,
        SessionStore.node,
        SessionInbox.node,
        Session.node,
      ]),
      [
        Project.node.replace(globalProjectNode),
        SessionExecution.node.replace(
          Layer.succeed(
            SessionExecution.Service,
            SessionExecution.Service.of({
              active: Effect.sync(() => new Set(execution.active)),
              isActive: (sessionID) => Effect.sync(() => execution.active.has(sessionID)),
              resume: () => Effect.void,
              wake: (sessionID) => Effect.sync(() => void execution.woken.push(sessionID)),
              interrupt: () => Effect.succeed(false),
              awaitIdle: () => Effect.void,
            }),
          ),
        ),
      ],
    ),
  )
  const bus = Context.get(context, Bus.Service)
  const sessions = Context.get(context, Session.Service)
  const published: Harness["published"] = []
  yield* bus
    .subscribe([
      Pacer.Event.StatusChanged,
      Pacer.Event.AccountsUpdated,
      Pacer.Event.ChatUpdated,
      Pacer.Event.RequestsUpdated,
    ])
    .pipe(
      Stream.runForEach((event) => Effect.sync(() => void published.push({ type: event.type, data: event.data }))),
      Effect.forkScoped({ startImmediately: true }),
    )
  // The connection's reads of the session store are counted.
  const counted = Session.Service.of({
    ...sessions,
    get: (sessionID) =>
      Effect.suspend(() => {
        lookups.count++
        return sessions.get(sessionID)
      }),
  })
  const pacer = yield* Layer.build(
    PacerConnection.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          PacerHttp.layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(endpoints)),
          endpoints,
          Layer.succeed(
            PacerModels.Service,
            PacerModels.Service.of({
              get: () => SubscriptionRef.get(models),
              changes: () => SubscriptionRef.changes(models),
              refresh: () => Effect.sync(() => void refreshes.count++),
            }),
          ),
          Layer.succeed(Bus.Service, bus),
          Layer.succeed(Session.Service, counted),
        ),
      ),
    ),
  )
  return {
    cpp,
    location: Location.Ref.make({ directory: AbsolutePath.make(folder.path) }),
    connection: Context.get(pacer, PacerConnection.Service),
    bus,
    sessions,
    enqueue: (sessionID: SessionID) =>
      Context.get(context, SessionInbox.Service)
        .admit({
          id: SessionMessage.ID.create(),
          sessionID,
          item: { type: "user", payload: { text: "next" }, delivery: "steer" },
        })
        .pipe(Effect.orDie),
    endpoint,
    catalog: models,
    refreshes,
    execution,
    published,
    lookups,
    connect: (key = "test-key") =>
      SubscriptionRef.set(endpoint, PacerEndpoint.resolve({ baseURL: `${cpp.origin}/v1`, apiKey: key }, undefined)),
  } satisfies Harness
})

/** Waits, on the real clock, until `ok` holds: the fake CPP and the database answer in real time. */
const until = Effect.fnUntraced(function* (what: string, ok: () => boolean) {
  const deadline = performance.now() + 5_000
  while (!ok()) {
    if (performance.now() > deadline) return yield* Effect.die(new Error(`never happened: ${what}`))
    yield* TestClock.withLive(Effect.sleep("2 millis"))
  }
})
/** Moves the test clock 100 ms at a time, letting real work run between, until `ok` holds; at most 2 virtual minutes. */
const ahead = Effect.fnUntraced(function* (what: string, ok: () => boolean) {
  for (let tick = 0; tick < 1_200 && !ok(); tick++) {
    yield* TestClock.adjust("100 millis")
    yield* TestClock.withLive(Effect.sleep("1 millis"))
  }
  if (!ok()) return yield* Effect.die(new Error(`never happened: ${what}`))
})
/** Lets real work already under way finish. */
const settle = TestClock.withLive(Effect.sleep("30 millis"))

const status = (h: Harness) => Effect.runSync(h.connection.status())
const seen = (h: Harness, path: string, method = "GET") =>
  h.cpp.seen.filter((item) => item.method === method && item.path === path)
const viewPath = (sessionID: SessionID) => `/pacer/v1/sessions/${PacerSessionID.make(sessionID)}`
/** The chat as the last `pacer.chat.updated` told it. */
const toldChat = (h: Harness, sessionID: SessionID) =>
  h.published
    .flatMap((event) => (event.type === "pacer.chat.updated" ? [(event.data as { chat: Pacer.Chat }).chat] : []))
    .findLast((item) => item.sessionID === sessionID)

/** Sends CPP's heartbeat and waits until the connection heard it. */
const heartbeat = Effect.fnUntraced(function* (h: Harness) {
  const now = yield* Clock.currentTimeMillis
  h.cpp.heartbeat()
  yield* until("the heartbeat heard", () => status(h).asOf === now)
})

/** Connects and waits until the pacer is on and the stream is open. */
const online = Effect.fnUntraced(function* (h: Harness) {
  yield* h.connect()
  yield* until("the pacer is on", () => status(h).state === "on" && h.cpp.streams() === 1)
})

const cppModel = { id: Model.ID.make("model-a"), providerID: Provider.ID.make("cliproxypacer") }
const otherModel = { id: Model.ID.make("model-b"), providerID: Provider.ID.make("other") }

/** A step's start and the end of its reply. */
const step = Effect.fnUntraced(function* (h: Harness, sessionID: SessionID, model = cppModel) {
  const assistantMessageID = SessionMessage.ID.create()
  yield* h.bus.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID,
    agent: Agent.ID.make("build"),
    model,
    started: 0,
  })
  yield* h.bus.publish(SessionEvent.Step.Streamed, { sessionID, assistantMessageID })
  return assistantMessageID
})

const chat = (h: Harness, parentID?: SessionID) =>
  Effect.map(
    parentID ? h.sessions.create({ parentID }) : h.sessions.create({ location: h.location }),
    (info) => info.id,
  )

describe("PacerConnection states", () => {
  it.effect("is not set up without an endpoint, and on once CPP answers", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* settle
      expect(status(h)).toMatchObject({ state: "unset", refused: false })
      expect(h.cpp.seen).toEqual([])
      expect(
        yield* h.connection.update(yield* chat(h), { warming: false }).pipe(
          Effect.flip,
          Effect.map((e) => e.state),
        ),
      ).toBe("unset")

      h.cpp.meters = [meter(h.cpp.time())]
      yield* online(h)
      expect(seen(h, "/pacer/v1/state")).toHaveLength(1)
      expect(h.published.filter((event) => event.type === "pacer.status").map((event) => event.data)).toMatchObject([
        { status: { state: "on", refused: false } },
      ])
      expect(yield* h.connection.accounts()).toMatchObject({ items: [{ alias: "account-a", provider: "prova" }] })
    }),
  )

  it.effect("parks a refused key until the address or the key changes", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      h.cpp.failure = { status: 401, type: "unauthorized" }
      yield* h.connect()
      yield* until("refused", () => status(h).refused)
      expect(status(h)).toMatchObject({ state: "unreachable", refused: true })
      expect(status(h).message).toContain("refused the key (401)")
      const asked = h.cpp.seen.length

      for (let second = 0; second < 120; second++) yield* TestClock.adjust("1 second")
      yield* settle
      expect(h.cpp.seen).toHaveLength(asked)

      h.cpp.failure = undefined
      yield* h.connect("another-key")
      yield* until("on with the new key", () => status(h).state === "on")
      expect(status(h).refused).toBe(false)
    }),
  )

  it.effect("says no pacer for a plain proxy, and connects once a catalog read finds the pacer", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      h.cpp.failure = "plain"
      yield* h.connect()
      yield* until("no pacer", () => status(h).state === "no-pacer")
      const asked = h.cpp.seen.length
      for (let second = 0; second < 120; second++) yield* TestClock.adjust("1 second")
      yield* settle
      // No polling while there is no pacer.
      expect(h.cpp.seen).toHaveLength(asked)

      h.cpp.failure = undefined
      yield* SubscriptionRef.set(h.catalog, catalog(yield* Clock.currentTimeMillis))
      yield* until("on", () => status(h).state === "on")
    }),
  )

  it.effect("leaves no pacer for a catalog read that found the pacer while the failing try was under way", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      h.cpp.failure = "plain"
      h.cpp.holds.add("/pacer/v1/state")
      yield* h.connect()
      yield* until("asked", () => seen(h, "/pacer/v1/state").length === 1)
      // The pacer is back, and a catalog read finds it, before the try's plain 404 comes.
      h.cpp.failure = undefined
      yield* SubscriptionRef.set(h.catalog, catalog(yield* Clock.currentTimeMillis))
      h.cpp.release()
      yield* until("on", () => status(h).state === "on" && h.cpp.streams() === 1)
      expect(seen(h, "/pacer/v1/state")).toHaveLength(2)
      expect(h.published.filter((event) => event.type === "pacer.status").map((event) => event.data)).toMatchObject([
        { status: { state: "no-pacer" } },
        { status: { state: "on" } },
      ])
    }),
  )

  it.effect("is unreachable while CPP's pacer store is not open (503 unavailable), and on once it is", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      h.cpp.failure = { status: 503, type: "unavailable" }
      yield* h.connect()
      yield* until("unreachable", () => status(h).state === "unreachable")
      expect(status(h)).toMatchObject({ state: "unreachable", refused: false })
      // Tried again after the wait, as any unreachable CPP: no catalog read has to find the pacer first.
      h.cpp.failure = undefined
      const asked = seen(h, "/pacer/v1/state").length
      yield* ahead("asked again", () => seen(h, "/pacer/v1/state").length === asked + 1)
      yield* until("on", () => status(h).state === "on")
      expect(
        h.published.some((event) => (event.data as { status?: { state?: string } }).status?.state === "no-pacer"),
      ).toBe(false)
    }),
  )

  it.effect(
    "reconnects after 1 s doubling to 30 s, never before a Retry-After, and stays on through an ended stream",
    () =>
      Effect.gen(function* () {
        const h = yield* harness()
        yield* online(h)

        // The stream ends: the status stays on, and the state is read again a second later.
        h.cpp.end()
        yield* settle
        expect(status(h).state).toBe("on")
        const ended = seen(h, "/pacer/v1/state").length
        yield* TestClock.adjust("999 millis")
        yield* settle
        expect(seen(h, "/pacer/v1/state")).toHaveLength(ended)
        yield* TestClock.adjust("1 millis")
        yield* until("read again", () => seen(h, "/pacer/v1/state").length === ended + 1)
        yield* until("on again", () => h.cpp.streams() === 1)

        // A stream that lasts 30 s is a working connection; when it ends and CPP answers 503 from then on, the tries
        // come 1, 2, 4, 8, 16, 30 and 30 s apart, and the status turns unreachable, as of CPP's last answer.
        for (let second = 1; second <= 31; second++) {
          yield* TestClock.adjust("1 second")
          if (second % 25 === 0) yield* heartbeat(h)
        }
        yield* settle
        h.cpp.failure = { status: 503 }
        const lastContact = status(h).asOf
        const endedAt = yield* Clock.currentTimeMillis
        h.cpp.end()
        yield* settle
        const failing = seen(h, "/pacer/v1/state").length
        for (let tick = 0; tick < 1_000 && seen(h, "/pacer/v1/state").length < failing + 7; tick++) {
          yield* TestClock.adjust("100 millis")
          yield* TestClock.withLive(Effect.sleep("1 millis"))
        }
        yield* until("unreachable", () => status(h).state === "unreachable")
        expect(status(h)).toMatchObject({ state: "unreachable", refused: false })
        expect(status(h).asOf).toBe(lastContact)
        const times = [
          endedAt,
          ...seen(h, "/pacer/v1/state")
            .slice(failing)
            .map((item) => item.at),
        ]
        const gaps = times.slice(1).map((at, index) => at - times[index])
        expect(gaps).toHaveLength(7)
        ;[1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].forEach((least, index) => {
          expect(gaps[index]).toBeGreaterThanOrEqual(least)
          expect(gaps[index]).toBeLessThan(least + 300)
        })

        // A Retry-After longer than the wait is honoured.
        h.cpp.failure = { status: 503, retryAfter: 45 }
        const count = seen(h, "/pacer/v1/state").length
        yield* ahead("asked once more", () => seen(h, "/pacer/v1/state").length === count + 1)
        const before = seen(h, "/pacer/v1/state")[count].at
        yield* ahead("asked again", () => seen(h, "/pacer/v1/state").length === count + 2)
        expect(seen(h, "/pacer/v1/state")[count + 1].at - before).toBeGreaterThanOrEqual(45_000)

        // CPP is back: on again.
        h.cpp.failure = undefined
        yield* ahead("on again", () => status(h).state === "on")
      }),
  )

  it.effect(
    "is on once the state answers, while it waits for the stream's headers as long as for a heartbeat, as a proxy may hold them until CPP's first bytes",
    () =>
      Effect.gen(function* () {
        const h = yield* harness()
        h.cpp.quiet = true
        yield* h.connect()
        yield* until("the stream asked for", () => h.cpp.streams() === 1)
        // On with the state's answer, before the stream sent a byte.
        yield* until("on", () => status(h).state === "on")
        expect(h.published.filter((event) => event.type === "pacer.status").map((event) => event.data)).toMatchObject([
          { status: { state: "on" } },
        ])
        // CPP's first heartbeat comes 25 s after the stream opened; on all along.
        for (let second = 0; second < 25; second++) {
          yield* TestClock.adjust("1 second")
          expect(status(h).state).toBe("on")
        }
        yield* settle
        // A notice before it is the stream's first bytes: followed as ever.
        h.cpp.notice("request", { keys: [1], at: 1 })
        yield* until("the notice heard", () => seen(h, "/pacer/v1/monitor/requests").length === 1)
        h.cpp.heartbeat()
        yield* settle
        expect(status(h).state).toBe("on")
        expect(seen(h, "/pacer/v1/stream")).toHaveLength(1)
        expect(h.published.filter((event) => event.type === "pacer.status")).toHaveLength(1)
      }),
  )

  it.effect("turns unreachable when the stream never answers after the state did, and on again after", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      h.cpp.quiet = true
      h.cpp.holds.add("/pacer/v1/stream")
      yield* h.connect()
      yield* until("on", () => status(h).state === "on")
      // No headers for 60 s: as gone as a silent stream.
      for (let second = 0; second < 61 && status(h).state === "on"; second++) {
        yield* TestClock.adjust("1 second")
        yield* settle
      }
      yield* until("unreachable", () => status(h).state === "unreachable")
      h.cpp.release()
      h.cpp.quiet = false
      yield* ahead("on again", () => status(h).state === "on" && h.cpp.streams() >= 1)
    }),
  )

  it.effect("connects again when the stream is silent for 60 s", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      for (let second = 0; second < 59; second++) yield* TestClock.adjust("1 second")
      yield* settle
      expect(seen(h, "/pacer/v1/stream")).toHaveLength(1)
      yield* TestClock.adjust("1 second")
      yield* settle
      yield* TestClock.adjust("1 second")
      yield* until("a second stream", () => seen(h, "/pacer/v1/stream").length === 2)
    }),
  )

  it.effect("sends CPP nothing but the open stream for 10 idle minutes", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      const asked = h.cpp.seen.map((item) => item.path)
      expect(asked).toEqual(["/pacer/v1/state", "/pacer/v1/stream"])
      for (let second = 1; second <= 600; second++) {
        yield* TestClock.adjust("1 second")
        if (second % 25 === 0) yield* heartbeat(h)
      }
      yield* settle
      expect(h.cpp.seen.map((item) => item.path)).toEqual(asked)
      expect(h.cpp.streams()).toBe(1)
    }),
  )
})

describe("PacerConnection notices", () => {
  it.effect("names the chat and its parent in pacer.requests.updated after a request notice", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      const parent = yield* chat(h)
      const child = yield* chat(h, parent)
      yield* step(h, parent)
      yield* step(h, child)
      yield* until("the subagent's parent is known", () => h.lookups.count >= 2)
      h.cpp.rows = [row(1, { session_ext: PacerSessionID.make(child), subagent: true })]
      h.published.length = 0

      h.cpp.notice("request", { keys: [1], at: 1 })
      yield* until("requests updated", () => h.published.some((event) => event.type === "pacer.requests.updated"))
      yield* settle
      expect(seen(h, "/pacer/v1/monitor/requests").map((item) => item.query.toString())).toEqual(["limit=50&from=0"])
      expect(h.published.filter((event) => event.type === "pacer.requests.updated").map((event) => event.data)).toEqual(
        [{ sessionID: child }, { sessionID: parent }],
      )

      // The next reads take only what is new.
      h.cpp.rows = [...h.cpp.rows, row(2, { session_ext: PacerSessionID.make(parent) })]
      h.cpp.notice("request", { keys: [1], at: 2 })
      yield* until("read again", () => seen(h, "/pacer/v1/monitor/requests").length === 2)
      expect(seen(h, "/pacer/v1/monitor/requests")[1].query.get("after")).toBe("1")
    }),
  )

  it.effect(
    "tells of a chat's requests CPP recorded before its step was seen here, for the newest 200 such chats",
    () =>
      Effect.gen(function* () {
        const h = yield* harness()
        yield* online(h)
        const parent = yield* chat(h)
        const child = yield* chat(h, parent)
        const early = yield* chat(h)
        yield* step(h, parent)
        yield* until("the parent held", () => h.lookups.count >= 1)
        // A first read, so that the next takes up to 500 new rows.
        h.cpp.notice("request", { keys: [1], at: 1 })
        yield* until("read", () => seen(h, "/pacer/v1/monitor/requests").length === 1)
        // The subagent's first request reached CPP before its step's start was published here; another client's 200
        // chats come after the early chat's request.
        h.cpp.rows = [
          row(1, { session_ext: PacerSessionID.make(early) }),
          ...Array.from({ length: PacerConnection.UNNAMED }, (_, index) =>
            row(2 + index, { session_ext: `another-client-${index}` }),
          ),
          row(500, { session_ext: PacerSessionID.make(child), subagent: true }),
        ]
        h.published.length = 0
        const told = () =>
          h.published.filter((event) => event.type === "pacer.requests.updated").map((event) => event.data)
        h.cpp.notice("request", { keys: [1], at: 2 })
        yield* until("read again", () => seen(h, "/pacer/v1/monitor/requests").length === 2)
        yield* settle
        expect(seen(h, "/pacer/v1/monitor/requests")[1].query.get("limit")).toBe("500")
        expect(told()).toEqual([])

        yield* step(h, child)
        yield* until("told", () => told().length === 2)
        expect(told()).toEqual([{ sessionID: child }, { sessionID: parent }])
        // Pushed out by the newer ones.
        yield* step(h, early)
        yield* settle
        expect(told()).toHaveLength(2)
      }),
  )

  it.effect("merges a session notice's list into the held views", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      const id = yield* chat(h)
      const uuid = PacerSessionID.make(id)
      h.cpp.views.set(uuid, chatView(uuid, h.cpp.time(), { pings: { active: false, pings_left: 0 } }))
      yield* step(h, id)
      yield* until("held", () => h.published.some((event) => event.type === "pacer.chat.updated"))
      h.published.length = 0

      h.cpp.listed = [
        {
          id: uuid,
          session_id: 7,
          warm: true,
          warm_until: h.cpp.time() + 300_000,
          pings: chatView(uuid, h.cpp.time()).pings,
        },
      ]
      h.cpp.notice("session", { keys: [1], at: 1 })
      yield* until("merged", () => h.published.some((event) => event.type === "pacer.chat.updated"))
      expect(seen(h, "/pacer/v1/sessions").map((item) => item.query.get("limit"))).toEqual(["100"])
      const held = yield* h.connection.chat(id)
      expect(held?.pings).toMatchObject({ active: true, left: 3 })
      // One view read, for the step; the notice read only the list.
      expect(seen(h, viewPath(id))).toHaveLength(1)
    }),
  )

  it.effect(
    "reads a listed chat's view again when its requests moved, once however often listed, never for an older list",
    () =>
      Effect.gen(function* () {
        const h = yield* harness()
        yield* online(h)
        const now = h.cpp.time()
        const ids = [yield* chat(h), yield* chat(h)]
        const [first, second] = ids.map((id) => PacerSessionID.make(id))
        const planned = (uuid: string, requests: number) =>
          chatView(uuid, now, {
            requests,
            last_at: now + requests,
            warming: {
              cold: false,
              size_tokens: 80_000,
              threshold: 70_000,
              compact_at: now + 30_000,
              compact_reason: "before-cold",
            },
          })
        h.cpp.views.set(first, planned(first, 5))
        h.cpp.views.set(second, planned(second, 5))
        for (const id of ids) yield* step(h, id)
        yield* until("both held", () => ids.every((id) => toldChat(h, id)?.compactAt !== undefined))
        const listed = (uuid: string, requests: number) => ({
          id: uuid,
          session_id: 7,
          requests,
          last_at: now + requests,
          generation: 1,
          warm: true,
          warm_until: now + 300_000,
          pings: chatView(uuid, now).pings,
        })
        // CPP compacted the first chat: a request of its own, and nothing planned after it. The list can't say so.
        h.cpp.views.set(first, chatView(first, now, { requests: 6, last_at: now + 6 }))
        h.cpp.listed = [listed(first, 6), listed(second, 5)]
        h.published.length = 0
        h.cpp.notice("session", { keys: [1], at: 1 })
        yield* until("read again", () => seen(h, viewPath(ids[0])).length === 2)
        yield* until("told", () => toldChat(h, ids[0]) !== undefined && toldChat(h, ids[0])?.compactAt === undefined)
        expect((yield* h.connection.chat(ids[0]))?.compactAt).toBeUndefined()
        // The second, listed as it was read, is neither read again nor told.
        expect((yield* h.connection.chat(ids[1]))?.compactAt).toBeDefined()
        expect(toldChat(h, ids[1])).toBeUndefined()

        // Listed again as it is: nothing more to read.
        h.cpp.notice("session", { keys: [1], at: 2 })
        yield* until("listed twice", () => seen(h, "/pacer/v1/sessions").length === 2)
        yield* settle
        expect(seen(h, viewPath(ids[0]))).toHaveLength(2)
        expect(seen(h, viewPath(ids[1]))).toHaveLength(1)

        // A list read before the view held now: nothing merged, nothing read.
        h.cpp.listed = [{ ...listed(first, 4), warm: false }]
        h.published.length = 0
        h.cpp.notice("session", { keys: [1], at: 3 })
        yield* until("listed three times", () => seen(h, "/pacer/v1/sessions").length === 3)
        yield* settle
        expect(h.published.filter((event) => event.type === "pacer.chat.updated")).toEqual([])
        expect(seen(h, viewPath(ids[0]))).toHaveLength(2)
        expect((yield* h.connection.chat(ids[0]))?.warm).toBe(true)
      }),
  )

  it.effect("reads a held chat's view again when asked, once CPP's list of the chats leaves it out", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      const ids = [yield* chat(h), yield* chat(h)]
      const [first, second] = ids.map((id) => PacerSessionID.make(id))
      for (const uuid of [first, second]) h.cpp.views.set(uuid, chatView(uuid, h.cpp.time()))
      for (const id of ids) yield* step(h, id)
      yield* until("both held", () => ids.every((id) => toldChat(h, id) !== undefined))

      // CPP lists only the newest chats, with no page after: the other one may have changed as any.
      h.cpp.listed = [{ id: first, session_id: 7, warm: true, warm_until: h.cpp.time() + 300_000 }]
      h.cpp.notice("session", { keys: [1], at: 1 })
      yield* until("listed", () => seen(h, "/pacer/v1/sessions").length === 1)
      yield* settle
      h.cpp.views.set(second, chatView(second, h.cpp.time(), { warm: false, warm_until: null }))
      expect((yield* h.connection.chat(ids[1]))?.warm).toBe(true)
      yield* until("read again", () => seen(h, viewPath(ids[1])).length === 2)
      yield* until("told", () => toldChat(h, ids[1])?.warm === false)
      // The listed one is as listed.
      yield* h.connection.chat(ids[0])
      yield* settle
      expect(seen(h, viewPath(ids[0]))).toHaveLength(1)
    }),
  )

  it.effect(
    "checks every chat CPP has on a compact notice for many, past a full list, and only the listed ones else",
    () =>
      Effect.gen(function* () {
        const h = yield* harness()
        yield* online(h)
        const now = h.cpp.time()
        const id = yield* chat(h)
        const uuid = PacerSessionID.make(id)
        h.cpp.views.set(uuid, chatView(uuid, now))
        yield* step(h, id)
        yield* until("held", () => toldChat(h, id) !== undefined)
        const plan = {
          cold: false,
          size_tokens: 80_000,
          threshold: 70_000,
          compact_at: now + 30_000,
          compact_reason: "before-cold",
        }
        h.cpp.views.set(uuid, chatView(uuid, now, { warming: plan }))
        const newer = (count: number) =>
          Array.from({ length: count }, (_, index) => ({
            id: `00000000-0000-5000-8000-${String(index).padStart(12, "0")}`,
            session_id: 100 + index,
            warm: true,
          }))

        // A list of the newest chats as long as CPP lists: more are active, the oldest left out.
        h.cpp.listed = newer(PacerConnection.LISTED)
        const woken = h.execution.woken.length
        h.cpp.notice("compact", { sessions: [], many: true, at: 1 })
        yield* until("compacted", () => h.execution.woken.slice(woken).includes(id))
        expect(seen(h, viewPath(id))).toHaveLength(2)
        expect((yield* h.sessions.inbox(id)).map((item) => item.type)).toEqual(["compaction"])

        // A shorter list is every active chat: one it leaves out is not active, and not read.
        h.cpp.listed = newer(3)
        h.cpp.notice("compact", { sessions: [], many: true, at: 2 })
        yield* until("listed again", () => seen(h, "/pacer/v1/sessions").length === 2)
        yield* settle
        expect(seen(h, viewPath(id))).toHaveLength(2)
      }),
  )

  it.effect("drops compacts at as openforge compacts the chat, before CPP answers, and reads its view again", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      const now = h.cpp.time()
      const id = yield* chat(h)
      const uuid = PacerSessionID.make(id)
      const plan = { cold: false, size_tokens: 80_000, threshold: 70_000, compact_at: now + 30_000 }
      h.cpp.views.set(uuid, chatView(uuid, now, { warming: { ...plan, compact_reason: "before-cold" } }))
      yield* step(h, id)
      yield* until("held", () => toldChat(h, id)?.compactAt !== undefined)
      const compaction = (model: typeof cppModel) =>
        Effect.gen(function* () {
          yield* h.bus.publish(SessionEvent.Compaction.Started, { sessionID: id, reason: "auto" })
          yield* h.bus.publish(SessionEvent.Compaction.Ended, { sessionID: id, reason: "auto", model, text: "summary" })
        })
      const cleared = () => toldChat(h, id) !== undefined && toldChat(h, id)?.compactAt === undefined

      // Through CPP: CPP is slow to answer, and "compacts at" goes without it.
      h.cpp.holds.add(viewPath(id))
      h.cpp.views.set(uuid, chatView(uuid, now))
      h.published.length = 0
      const reads = seen(h, viewPath(id)).length
      yield* compaction(cppModel)
      yield* until("cleared", cleared)
      // The view's read is asked for, and held unanswered until now.
      yield* until("read asked", () => seen(h, viewPath(id)).length === reads + 1 && h.cpp.inflight.now === 1)
      h.cpp.release()
      yield* settle
      expect((yield* h.connection.chat(id))?.compactAt).toBeUndefined()

      // Through another provider: told to CPP, then read again, with "compacts at" gone at once too.
      h.cpp.views.set(uuid, chatView(uuid, now, { warming: { ...plan, compact_reason: "cold" } }))
      yield* step(h, id)
      yield* until("planned again", () => toldChat(h, id)?.compactAt !== undefined)
      h.cpp.views.set(uuid, chatView(uuid, now))
      h.published.length = 0
      const before = seen(h, viewPath(id)).length
      yield* compaction(otherModel)
      yield* until("cleared again", cleared)
      yield* until("told and read", () => seen(h, viewPath(id)).length === before + 1)
      expect(seen(h, `${viewPath(id)}/events`, "POST").map((item) => item.body)).toEqual([{ type: "compacted" }])
      yield* settle
      expect((yield* h.connection.chat(id))?.compactAt).toBeUndefined()
    }),
  )

  it.effect("reads the meters at most every 10 s, and asks the catalog again on prices and capabilities", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      h.cpp.meters = [meter(h.cpp.time())]
      yield* online(h)
      h.cpp.meters = [meter(h.cpp.time(), { label: "account-c" })]
      h.cpp.notice("reading", { at: 1 })
      const updates = () => h.published.filter((event) => event.type === "pacer.accounts.updated").length
      // Held (after the state's at connect): the 10 s rest starts now.
      yield* until("read", () => updates() === 2)
      yield* settle
      expect(seen(h, "/pacer/v1/meters")).toHaveLength(1)
      for (let notice = 0; notice < 5; notice++) {
        h.cpp.notice("reading", { at: 2 })
        yield* TestClock.adjust("1 second")
        yield* settle
      }
      expect(seen(h, "/pacer/v1/meters")).toHaveLength(1)
      yield* TestClock.adjust("5 seconds")
      yield* until("read once more", () => seen(h, "/pacer/v1/meters").length === 2)
      yield* TestClock.adjust("20 seconds")
      yield* settle
      expect(seen(h, "/pacer/v1/meters")).toHaveLength(2)
      expect(h.published.filter((event) => event.type === "pacer.accounts.updated")).toHaveLength(2)

      const before = h.refreshes.count
      h.cpp.notice("capabilities", { at: 4 })
      yield* until("capabilities", () => h.refreshes.count === before + 1)
      h.cpp.notice("price", { at: 5 })
      yield* until("price", () => h.refreshes.count === before + 2)

      h.cpp.notice("resync", { at: 6 })
      yield* until("everything", () => seen(h, "/pacer/v1/state").length === 2 && h.refreshes.count === before + 3)
      yield* until("the requests too", () => seen(h, "/pacer/v1/monitor/requests").length === 1)
    }),
  )
})

describe("PacerConnection chats", () => {
  it.effect("reads a chat's view once after its step, beside it, and corrects CPP's times by Date", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* TestClock.setTime(1_800_000_000_000)
      // CPP's clock runs two minutes ahead.
      h.cpp.offset = 120_000
      h.cpp.meters = [meter(h.cpp.time())]
      yield* online(h)
      const id = yield* chat(h)
      const uuid = PacerSessionID.make(id)
      const warmUntil = h.cpp.time() + 300_000
      h.cpp.views.set(uuid, chatView(uuid, h.cpp.time(), { warm_until: warmUntil }))

      yield* step(h, id)
      yield* until("read", () => h.published.some((event) => event.type === "pacer.chat.updated"))
      expect(seen(h, viewPath(id))).toHaveLength(1)
      const held = yield* h.connection.chat(id)
      expect(held).toMatchObject({
        sessionID: id,
        account: "account-a",
        warm: true,
        nextUse: { account: "account-b", reason: "cold_move" },
        switches: { warming: true, compactBeforeCold: false },
      })
      // Every answer came at the same moment, so `Date` says CPP's clock to within its second: the middle of it.
      expect(Math.abs(held!.warmUntil! - (warmUntil - 120_000))).toBeLessThanOrEqual(500)
      expect(held!.coldAt).toBe(held!.warmUntil! + 3 * 240_000)
      expect(seen(h, viewPath(id))).toHaveLength(1)
      const accounts = yield* h.connection.accounts()
      expect(accounts?.items[0].windows[0]).toMatchObject({ label: "5h", left: 62, stale: false })
      const resetsAt = h.cpp.time() - 120_000 + 4_800_000
      expect(Math.abs(accounts!.items[0].windows[0].resetsAt! - resetsAt)).toBeLessThanOrEqual(500)
    }),
  )

  it.effect(
    "narrows CPP's clock by answers in different seconds, keeps it across a reconnect, starts over on a jump",
    () =>
      Effect.gen(function* () {
        const h = yield* harness()
        const offset = 120_000
        // CPP's clock reads .900 of a second, two minutes ahead.
        yield* TestClock.setTime(1_800_000_000_900)
        h.cpp.offset = offset
        yield* online(h)
        // The state's and the stream's `Date`: CPP's clock minus this one lies in [offset - 900, offset + 100].
        const id = yield* chat(h)
        const uuid = PacerSessionID.make(id)
        const warmUntil = h.cpp.time() + 300_000
        h.cpp.views.set(uuid, chatView(uuid, h.cpp.time(), { warm_until: warmUntil }))
        // The view's at .000 of the next second: in [offset, offset + 1000]; together, [offset, offset + 100].
        yield* TestClock.adjust("100 millis")
        yield* step(h, id)
        yield* until("read", () => h.published.some((event) => event.type === "pacer.chat.updated"))
        const shown = (yield* h.connection.chat(id))!.warmUntil!
        expect(shown).toBeGreaterThanOrEqual(warmUntil - offset - 100)
        expect(shown).toBeLessThanOrEqual(warmUntil - offset)

        // CPP's stream ends at .900; the reconnect a second later answers at .900 too, which alone would say a second
        // less. The times shown stay where they were.
        yield* TestClock.adjust("900 millis")
        h.cpp.end()
        yield* settle
        yield* TestClock.adjust("1 second")
        yield* until("connected again", () => seen(h, "/pacer/v1/state").length === 2 && h.cpp.streams() === 1)
        expect((yield* h.connection.chat(id))?.warmUntil).toBe(shown)
        yield* until("read again after the reconnect", () => seen(h, viewPath(id)).length === 2)
        yield* settle
        expect((yield* h.connection.chat(id))?.warmUntil).toBe(shown)

        // CPP's clock jumps a minute ahead: the next answer doesn't meet the bounds held, which start over from it.
        h.cpp.offset = offset + 60_000
        yield* step(h, id)
        yield* until("read after the jump", () => seen(h, viewPath(id)).length === 3)
        yield* until("moved", () => toldChat(h, id)?.warmUntil !== shown)
        const jumped = (yield* h.connection.chat(id))!.warmUntil!
        expect(Math.abs(jumped - (warmUntil - offset - 60_000))).toBeLessThanOrEqual(1_000)
      }),
  )

  it.effect("costs a chat CPP doesn't know one lookup per event: no read, no store read", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      const ids = yield* Effect.forEach(Array.from({ length: 50 }), () => chat(h))
      const lookups = h.lookups.count
      const asked = h.cpp.seen.length
      for (const id of ids) {
        const assistantMessageID = yield* step(h, id, otherModel)
        yield* h.bus.publish(SessionEvent.Tool.Input.Started, {
          sessionID: id,
          assistantMessageID,
          id: "call",
          name: "shell",
        })
        yield* h.bus.publish(SessionEvent.Tool.Called, {
          sessionID: id,
          assistantMessageID,
          id: "call",
          input: { command: "sleep 100" },
          executed: false,
        })
        yield* h.bus.publish(SessionEvent.Execution.Succeeded, { sessionID: id })
      }
      yield* settle
      expect(h.cpp.seen).toHaveLength(asked)
      expect(h.lookups.count).toBe(lookups)
    }),
  )

  it.effect("coalesces the reads after many steps: one queue, at most 4 reads at once, about one per chat", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      const ids = yield* Effect.forEach(Array.from({ length: 200 }), () => chat(h))
      for (const id of ids) h.cpp.views.set(PacerSessionID.make(id), chatView(PacerSessionID.make(id), h.cpp.time()))
      // Every view read waits until the steps are all published, so they pile up.
      h.cpp.holds.add("/pacer/v1/sessions/")
      for (let round = 0; round < 5; round++) for (const id of ids) yield* step(h, id)
      yield* until("4 reads in flight", () => h.cpp.inflight.now === 4)
      yield* settle
      expect(h.cpp.inflight.now).toBe(4)
      h.cpp.release()
      const reads = () => ids.reduce((sum, id) => sum + seen(h, viewPath(id)).length, 0)
      yield* until("every chat read", () => ids.every((id) => seen(h, viewPath(id)).length >= 1))
      yield* settle
      expect(h.cpp.inflight.most).toBe(4)
      // 1000 steps: one read per chat, and one more for the 4 chats whose read was in flight when they were marked.
      expect(reads()).toBeLessThanOrEqual(204)
      expect(Math.max(...ids.map((id) => seen(h, viewPath(id)).length))).toBeLessThanOrEqual(2)
    }),
  )

  it.effect("answers held views and accounts at once, and reads a stale view in the background", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      h.cpp.meters = [meter(h.cpp.time())]
      yield* online(h)
      const id = yield* chat(h)
      const uuid = PacerSessionID.make(id)
      h.cpp.views.set(uuid, chatView(uuid, h.cpp.time()))
      yield* step(h, id)
      yield* until("held", () => h.published.some((event) => event.type === "pacer.chat.updated"))

      // CPP stops answering: held answers come back without waiting for it.
      h.cpp.holds.add("/pacer/v1/")
      expect((yield* h.connection.chat(id))?.sessionID).toBe(id)
      expect((yield* h.connection.accounts())?.items).toHaveLength(1)
      h.cpp.release()

      // A reading makes the view stale: still answered at once, then read again and published when it changed.
      h.cpp.meters = [meter(h.cpp.time(), { label: "account-a2" })]
      h.published.length = 0
      h.cpp.notice("reading", { at: 1 })
      yield* until("meters", () => h.published.some((event) => event.type === "pacer.accounts.updated"))
      expect(seen(h, "/pacer/v1/meters")).toHaveLength(1)
      h.cpp.views.set(uuid, chatView(uuid, h.cpp.time(), { force_use: { credential: "account-b", when: "now" } }))
      h.published.length = 0
      h.cpp.holds.add(viewPath(id))
      const reads = seen(h, viewPath(id)).length
      const held = yield* h.connection.chat(id)
      expect(held?.forceUse).toBeUndefined()
      yield* until("read in the background", () => seen(h, viewPath(id)).length === reads + 1)
      h.cpp.release()
      yield* until("published", () => h.published.some((event) => event.type === "pacer.chat.updated"))
      expect((yield* h.connection.chat(id))?.forceUse).toEqual({ account: "account-b", when: "now" })

      // A chat CPP is not known to have: undefined at once, looked up beside it, never again after a 404.
      const other = yield* chat(h)
      expect(yield* h.connection.chat(other)).toBeUndefined()
      yield* until("looked up", () => seen(h, viewPath(other)).length === 1)
      yield* settle
      expect(yield* h.connection.chat(other)).toBeUndefined()
      yield* settle
      expect(seen(h, viewPath(other))).toHaveLength(1)
    }),
  )

  it.effect("sets the switches on CPP and answers the view after the change", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      const id = yield* chat(h)
      const updated = yield* h.connection.update(id, { warming: false, compactBeforeCold: true })
      expect(seen(h, viewPath(id), "PATCH").map((item) => item.body)).toEqual([
        { "pings.enabled": false, "warming.compact_before_cold": true },
      ])
      expect(updated.switches).toEqual({ warming: false, compactBeforeCold: true })
      expect(h.published.filter((event) => event.type === "pacer.chat.updated")).toHaveLength(1)
    }),
  )

  it.effect("keeps a chat warm while it waits on a foreground command or a subagent, not a background one", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      const id = yield* chat(h)
      h.cpp.views.set(PacerSessionID.make(id), chatView(PacerSessionID.make(id), h.cpp.time()))
      const assistantMessageID = yield* step(h, id)
      const call = (callID: string, name: string, input: Json) =>
        Effect.gen(function* () {
          yield* h.bus.publish(SessionEvent.Tool.Input.Started, { sessionID: id, assistantMessageID, id: callID, name })
          yield* h.bus.publish(SessionEvent.Tool.Called, {
            sessionID: id,
            assistantMessageID,
            id: callID,
            input,
            executed: false,
          })
        })
      const done = (callID: string) =>
        h.bus.publish(SessionEvent.Tool.Success, {
          sessionID: id,
          assistantMessageID,
          id: callID,
          content: [{ type: "text", text: "done" }],
          executed: false,
        })
      const patches = () => seen(h, viewPath(id), "PATCH").map((item) => item.body)

      yield* call("server", "shell", { command: "bun run dev", background: true })
      yield* call("sleep", "shell", { command: "sleep 600" })
      yield* until("raised", () => patches().length === 1)
      yield* call("agent", "subagent", { prompt: "look" })
      yield* done("sleep")
      yield* settle
      expect(patches()).toEqual([{ "pings.duration_minutes": 240 }])
      yield* done("agent")
      yield* until("cleared", () => patches().length === 2)
      yield* done("server")
      yield* settle
      expect(patches()).toEqual([{ "pings.duration_minutes": 240 }, { "pings.duration_minutes": null }])

      // A run stopped while it waited waits no more, though the call's end is published only at its next run.
      yield* call("long", "shell", { command: "sleep 3600" })
      yield* until("raised again", () => patches().length === 3)
      yield* h.bus.publish(SessionEvent.Execution.Interrupted, { sessionID: id, reason: "user" })
      yield* until("cleared again", () => patches().length === 4)
      expect(patches().slice(2)).toEqual([{ "pings.duration_minutes": 240 }, { "pings.duration_minutes": null }])
    }),
  )

  it.effect("compacts a chat CPP asks to, unless it runs, has queued input or a staged revert", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      const idle = yield* chat(h)
      const running = yield* chat(h)
      const queued = yield* chat(h)
      const reverting = yield* chat(h)
      const steps = yield* Effect.forEach([idle, running, queued, reverting], (id) => step(h, id))
      h.execution.active.add(running)
      yield* h.enqueue(queued)
      // A revert to the step's reply: Session.compact could commit it, so only the rule keeps the chat alone.
      yield* h.bus.publish(SessionEvent.RevertEvent.Staged, { sessionID: reverting, revert: { messageID: steps[3] } })
      const woken = h.execution.woken.length

      h.cpp.notice("compact", {
        sessions: [idle, running, queued, reverting].map((id) => ({ key: 1, session: PacerSessionID.make(id) })),
        at: 1,
      })
      yield* until("compacted", () => h.execution.woken.slice(woken).includes(idle))
      yield* settle
      expect(h.execution.woken.slice(woken)).toEqual([idle])
      expect((yield* h.sessions.inbox(idle)).map((item) => item.type)).toEqual(["compaction"])
      expect((yield* h.sessions.inbox(running)).map((item) => item.type)).toEqual([])
    }),
  )

  it.effect("compacts a chat CPP asks to with its own model on CPP, never another provider's", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      const own = yield* chat(h)
      const switched = yield* chat(h)
      const away = yield* chat(h)
      yield* Effect.forEach([own, switched, away], (id) => step(h, id))
      const later = { id: Model.ID.make("model-c"), providerID: Provider.ID.make("cliproxypacer") }
      yield* h.sessions.switchModel({ sessionID: switched, model: later })
      yield* h.sessions.switchModel({ sessionID: away, model: otherModel })
      const woken = h.execution.woken.length

      h.cpp.notice("compact", {
        sessions: [own, switched, away].map((id) => ({ key: 1, session: PacerSessionID.make(id) })),
        at: 1,
      })
      yield* until("compacted", () => h.execution.woken.slice(woken).length === 2)
      yield* settle
      const payloads = (id: SessionID) =>
        Effect.map(h.sessions.inbox(id), (items) => items.map((item) => item.type === "compaction" && item.payload))
      // The model of its last answer, whose cache is warm, then the one selected since; never the compaction agent's.
      expect(yield* payloads(own)).toEqual([{ models: [cppModel] }])
      expect(yield* payloads(switched)).toEqual([
        { models: [cppModel, { ...later, variant: Model.VariantID.make("default") }] },
      ])
      expect(yield* payloads(away)).toEqual([])
      expect(h.execution.woken.slice(woken).toSorted()).toEqual([own, switched].toSorted())
    }),
  )

  it.effect("marks the held views stale on a settings notice, and reads nothing for it", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      const id = yield* chat(h)
      const uuid = PacerSessionID.make(id)
      h.cpp.views.set(uuid, chatView(uuid, h.cpp.time()))
      yield* step(h, id)
      yield* until("held", () => h.published.some((event) => event.type === "pacer.chat.updated"))
      const refreshes = h.refreshes.count
      const asked = h.cpp.seen.length
      h.cpp.notice("settings", { at: 1 })
      // A notice behind it, handled after it: the catalog is read for this one only.
      h.cpp.notice("capabilities", { at: 2 })
      yield* until("capabilities", () => h.refreshes.count === refreshes + 1)
      yield* settle
      expect(h.refreshes.count).toBe(refreshes + 1)
      expect(h.cpp.seen).toHaveLength(asked)
      // Asked for, the held view is answered at once and read again beside it.
      expect((yield* h.connection.chat(id))?.sessionID).toBe(id)
      yield* until("read again", () => seen(h, viewPath(id)).length === 2)
    }),
  )

  it.effect("tells CPP each chat event once per change", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      const parent = yield* chat(h)
      const child = yield* chat(h, parent)
      yield* step(h, parent)
      yield* step(h, child)
      const events = (id: SessionID) => seen(h, `${viewPath(id)}/events`, "POST").map((item) => item.body as Json)

      yield* h.sessions.switchModel({ sessionID: parent, model: otherModel })
      yield* until("the first change told", () => events(parent).length === 1)
      // Another provider's model again: CPP already knows the chat's model is none of its own.
      yield* h.sessions.switchModel({ sessionID: parent, model: { ...otherModel, id: Model.ID.make("model-c") } })
      yield* settle
      expect(events(parent)).toHaveLength(1)
      yield* h.sessions.switchModel({ sessionID: parent, model: cppModel })
      yield* h.sessions.switchAgent({ sessionID: parent, agent: Agent.ID.make("plan") })
      yield* h.sessions.rename({ sessionID: parent, title: "A synthetic title" })
      yield* until("labelled", () => events(parent).some((event) => event.type === "label"))
      // The same title again is no change.
      yield* h.bus.publish(SessionEvent.Renamed, { sessionID: parent, title: "A synthetic title" })
      const revert = () =>
        h.bus.publish(SessionEvent.RevertEvent.Staged, {
          sessionID: parent,
          revert: { messageID: SessionMessage.ID.create() },
        })
      yield* revert()
      yield* until("reverted", () => events(parent).some((event) => event.type === "reverted"))
      // The same again before the chat's next step is not told again.
      yield* revert()
      const compaction = (model: typeof cppModel) =>
        Effect.gen(function* () {
          yield* h.bus.publish(SessionEvent.Compaction.Started, { sessionID: parent, reason: "manual" })
          yield* h.bus.publish(SessionEvent.Compaction.Ended, {
            sessionID: parent,
            reason: "manual",
            model,
            text: "summary",
          })
        })
      // CPP saw a compaction that went through it; one through another provider is told.
      yield* compaction(cppModel)
      yield* settle
      expect(events(parent)).toHaveLength(5)
      yield* compaction(otherModel)
      yield* until("told", () => events(parent).length === 6)
      yield* settle
      expect(events(parent)).toEqual([
        { type: "model_changed", model: null },
        { type: "model_changed", model: "model-a" },
        { type: "agent_switched" },
        { type: "label", label: "A synthetic title" },
        { type: "reverted" },
        { type: "compacted" },
      ])

      // A subagent's run ending closes its chat once until its next step; a root chat's run ending closes nothing.
      yield* h.bus.publish(SessionEvent.Execution.Succeeded, { sessionID: child })
      yield* until("closed", () => events(child).length === 1)
      yield* h.bus.publish(SessionEvent.Execution.Succeeded, { sessionID: child })
      yield* h.bus.publish(SessionEvent.Execution.Succeeded, { sessionID: parent })
      yield* settle
      expect(events(child)).toEqual([{ type: "closed" }])
      expect(events(parent)).toHaveLength(6)
      yield* step(h, child)
      yield* h.bus.publish(SessionEvent.Execution.Succeeded, { sessionID: child })
      yield* until("closed after its next step", () => events(child).length === 2)

      // Deleting the chat closes it.
      yield* h.sessions.remove(parent)
      yield* until("deleted", () => events(parent).length === 7)
      expect(events(parent).at(-1)).toEqual({ type: "closed" })
    }),
  )
})

describe("PacerConnection reads", () => {
  it.effect("lists a chat's requests with its subagents', and keeps the last 50 what-changed answers", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* online(h)
      const parent = yield* chat(h)
      const child = yield* chat(h, parent)
      const uuid = PacerSessionID.make(parent)
      h.cpp.views.set(uuid, chatView(uuid, h.cpp.time(), { session_id: 7 }))
      h.cpp.rows = [
        row(1, { session_ext: uuid }),
        row(2, { session_ext: PacerSessionID.make(child), subagent: true, session_id: 8, root_id: 7 }),
        row(3, {
          session_ext: uuid,
          cache_verdict: "miss",
          cache_cause: "system changed",
          cache_base: 1,
          miss_cost: 2_000,
        }),
      ]
      h.cpp.prompts.set("req-3", {
        kept: true,
        previous: 1,
        removed: ["messages[4]"],
        rows: [
          { item: 0, path: "model", kind: "option", summary: "model = a", chars: 6, change: "same" },
          { item: 1, path: "messages[0].content", kind: "system", summary: "You are", chars: 900, change: "changed" },
          { item: 2, path: "tools[0]", kind: "tool", summary: "shell", chars: 400, change: "new" },
        ],
      })

      const page = yield* h.connection.requests(parent, { filter: "all" })
      expect(page.items.map((item) => [item.id, item.sessionID, item.subagent, item.miss])).toEqual([
        ["req-3", parent, false, true],
        ["req-2", child, true, false],
        ["req-1", parent, false, false],
      ])
      expect(page.items[0]).toMatchObject({
        model: "model-a",
        account: "account-a",
        kind: "step",
        cause: "system changed",
      })
      expect(page.items[0].tokens).toEqual({ input: 10, output: 5, reasoning: 0, cacheRead: 100, cacheWrite: 20 })
      const misses = yield* h.connection.requests(parent, { filter: "misses" })
      expect(misses.items.map((item) => item.id)).toEqual(["req-3"])

      const change = yield* h.connection.prompt("req-3")
      expect(change).toMatchObject({
        request: { id: "req-3", verdict: "miss" },
        comparedWith: { id: "req-1" },
        kept: "all",
        removed: ["messages[4]"],
        unchanged: 1,
      })
      expect(change?.items.map((item) => [item.path, item.change])).toEqual([
        ["messages[0].content", "changed"],
        ["tools[0]", "new"],
      ])
      const reads = h.cpp.seen.length
      expect(yield* h.connection.prompt("req-3")).toEqual(change)
      expect(h.cpp.seen).toHaveLength(reads)

      // A request whose prompt CPP no longer holds.
      expect((yield* h.connection.prompt("req-1"))?.kept).toBe("none")
      expect(yield* h.connection.prompt("req-404")).toBeUndefined()

      // The last 50: the 51st answer read pushes the oldest out.
      h.cpp.rows = [...h.cpp.rows, ...Array.from({ length: 50 }, (_, index) => row(100 + index, { session_ext: uuid }))]
      for (let index = 0; index < 50; index++) h.cpp.prompts.set(`req-${100 + index}`, { kept: true, rows: [] })
      for (let index = 0; index < 50; index++) yield* h.connection.prompt(`req-${100 + index}`)
      const again = h.cpp.seen.length
      yield* h.connection.prompt("req-149")
      expect(h.cpp.seen).toHaveLength(again)
      yield* h.connection.prompt("req-3")
      expect(h.cpp.seen.length).toBeGreaterThan(again)
    }),
  )
})
