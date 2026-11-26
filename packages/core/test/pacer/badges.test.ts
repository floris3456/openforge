import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { PacerBadges } from "@opencode/core/pacer/badges"
import { PacerEndpoint } from "@opencode/core/pacer/endpoint"
import { PacerHttp } from "@opencode/core/pacer/http"
import { PacerModels } from "@opencode/core/pacer/models"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Pacer } from "@opencode/schema/pacer"
import { SessionID } from "@opencode/schema/session-id"
import { catalogOf } from "../memory/fixture"
import { testEffect } from "../lib/effect"

// Agents' colours (the workspace's spec docs/specs/agent-badges.md, section 3, item 3): the service keeps the badge
// CLIProxyPacer gives with each chat, `agent_badge` beside `agent_identity`, learnt from the views and lists the
// connection reads; a chat the TUI asks about that nothing named is read from its session view, once, and told when
// known. Only while CPP's capabilities say `memory.badges`.

interface Seen {
  readonly method: string
  readonly path: string
}

/** A stand-in CPP that records each request and answers with `answer`. */
const serve = (answer: (seen: Seen) => Response) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const seen: Seen[] = []
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          const url = new URL(request.url)
          const one = { method: request.method, path: url.pathname }
          seen.push(one)
          return answer(one)
        },
      })
      return { seen, origin: `http://127.0.0.1:${server.port}`, server }
    }),
    (served) => Effect.promise(() => served.server.stop(true)),
  )

const it = testEffect(Layer.empty)

/** The service against `origin`, CPP's capabilities saying badges or not, with the badges told on the bus. */
const setup = Effect.fnUntraced(function* (origin: string, badges: boolean) {
  const current = PacerEndpoint.resolve({ baseURL: `${origin}/v1`, apiKey: "badges-test-key" }, undefined)
  const endpoints = Layer.succeed(
    PacerEndpoint.Service,
    PacerEndpoint.Service.of({ get: () => Effect.succeed(current), changes: () => Stream.make(current) }),
  )
  const catalog = catalogOf(true, { identities: true, badges })
  const models = Layer.succeed(
    PacerModels.Service,
    PacerModels.Service.of({
      get: () => Effect.succeed(catalog),
      changes: () => Stream.make(catalog),
      refresh: () => Effect.void,
    }),
  )
  const context = yield* Layer.build(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node])))
  const bus = Context.get(context, Bus.Service)
  const told: Array<{ readonly sessionID: string; readonly badge: Pacer.Badge | null }> = []
  yield* bus.subscribe(Pacer.Event.BadgeUpdated).pipe(
    Stream.runForEach((event) => Effect.sync(() => void told.push(event.data))),
    Effect.forkScoped({ startImmediately: true }),
  )
  const service = yield* Layer.build(
    PacerBadges.layer.pipe(
      Layer.provide(PacerHttp.layer.pipe(Layer.provide(endpoints), Layer.provide(FetchHttpClient.layer))),
      Layer.provide([endpoints, models, Layer.succeed(Bus.Service, bus)]),
    ),
  )
  return { badges: Context.get(service, PacerBadges.Service), told }
})

const CHAT = SessionID.make("ses_badges_chat")
const OTHER = SessionID.make("ses_badges_other")
const scheme = { hue: 240, level: 1, opposite: false, background: "#00537C", subject: "#cce9ff", detail: "#11212c" }
/** A chat's view as CPP answers it, with its identity's badge, or `null` for none. */
const view = (uuid: string, badge: typeof scheme | null) =>
  Response.json({
    id: uuid,
    agent_identity: badge ? "k3m9x2v7p0qa" : null,
    agent_badge: badge ? { scheme: badge, family: "k3m9x2v7p0qa", pattern: 273, letter: "A", state: "drawn" } : null,
  })

/** Waits until `ok` holds, polling the real clock: the reads are real requests. */
const until = (ok: () => boolean) =>
  Effect.promise(async () => {
    const deadline = Date.now() + 5_000
    while (!ok()) {
      if (Date.now() > deadline) throw new Error("never held")
      await Bun.sleep(2)
    }
  })

describe("PacerBadges", () => {
  it.live("reads a chat it doesn't know from its session view once, tells its badge, and gives it from then on", () =>
    Effect.gen(function* () {
      const cpp = yield* serve((seen) => view(seen.path.split("/").at(-1)!, scheme))
      const { badges, told } = yield* setup(cpp.origin, true)
      expect(yield* badges.get([CHAT])).toEqual({ items: [] })
      yield* until(() => told.length === 1)
      const badge = { background: "#00537c", hue: 240 }
      expect(told).toEqual([{ sessionID: CHAT, badge }])
      expect(cpp.seen).toEqual([{ method: "GET", path: `/pacer/v1/sessions/${PacerSessionID.make(CHAT)}` }])
      expect(yield* badges.get([CHAT])).toEqual({ items: [{ sessionID: CHAT, badge }] })
      expect(cpp.seen).toHaveLength(1)
    }),
  )

  it.live("a chat without an identity, and one CPP doesn't know, have none", () =>
    Effect.gen(function* () {
      const cpp = yield* serve((seen) =>
        seen.path.endsWith(PacerSessionID.make(CHAT))
          ? view(PacerSessionID.make(CHAT), null)
          : Response.json({ error: { type: "not_found", message: "no such session" } }, { status: 404 }),
      )
      const { badges, told } = yield* setup(cpp.origin, true)
      yield* badges.get([CHAT, OTHER])
      yield* until(() => told.length === 2)
      expect(told.toSorted((a, b) => a.sessionID.localeCompare(b.sessionID))).toEqual([
        { sessionID: CHAT, badge: null },
        { sessionID: OTHER, badge: null },
      ])
      expect(yield* badges.get([CHAT, OTHER])).toEqual({
        items: [
          { sessionID: CHAT, badge: null },
          { sessionID: OTHER, badge: null },
        ],
      })
      expect(cpp.seen).toHaveLength(2)
    }),
  )

  it.live("learns the badges of the views and list items the connection reads, without a read of its own", () =>
    Effect.gen(function* () {
      const cpp = yield* serve(() => new Response("unexpected", { status: 500 }))
      const { badges, told } = yield* setup(cpp.origin, true)
      yield* badges.learn(PacerSessionID.make(CHAT), { agent_badge: { scheme } })
      yield* badges.learn(PacerSessionID.make(OTHER), { agent_badge: null })
      expect(yield* badges.get([CHAT, OTHER])).toEqual({
        items: [
          { sessionID: CHAT, badge: { background: "#00537c", hue: 240 } },
          { sessionID: OTHER, badge: null },
        ],
      })
      // A chat asked about whose badge changes, as after a link, is told.
      yield* badges.learn(PacerSessionID.make(CHAT), {
        agent_badge: { scheme: { ...scheme, background: "#da6a76", hue: 15 } },
      })
      yield* until(() => told.length === 1)
      expect(told).toEqual([{ sessionID: CHAT, badge: { background: "#da6a76", hue: 15 } }])
      // An item from a CPP without badges says nothing of them, and changes nothing.
      yield* badges.learn(PacerSessionID.make(CHAT), {})
      expect((yield* badges.get([CHAT])).items).toEqual([
        { sessionID: CHAT, badge: { background: "#da6a76", hue: 15 } },
      ])
      expect(cpp.seen).toEqual([])
    }),
  )

  it.live("forgetting a chat's badge, as a link does, reads it again", () =>
    Effect.gen(function* () {
      const cpp = yield* serve((seen) => view(seen.path.split("/").at(-1)!, scheme))
      const { badges, told } = yield* setup(cpp.origin, true)
      yield* badges.learn(PacerSessionID.make(CHAT), { agent_badge: null })
      expect((yield* badges.get([CHAT])).items).toEqual([{ sessionID: CHAT, badge: null }])
      yield* badges.forget(CHAT)
      yield* until(() => told.length === 1)
      expect(told).toEqual([{ sessionID: CHAT, badge: { background: "#00537c", hue: 240 } }])
      expect(cpp.seen).toHaveLength(1)
    }),
  )

  it.live("without memory.badges in CPP's capabilities it reads nothing and gives nothing", () =>
    Effect.gen(function* () {
      const cpp = yield* serve((seen) => view(seen.path.split("/").at(-1)!, scheme))
      const { badges, told } = yield* setup(cpp.origin, false)
      yield* badges.learn(PacerSessionID.make(OTHER), { agent_badge: { scheme } })
      expect(yield* badges.get([CHAT, OTHER])).toEqual({ items: [] })
      yield* Effect.promise(() => Bun.sleep(50))
      expect(cpp.seen).toEqual([])
      expect(told).toEqual([])
    }),
  )
})
