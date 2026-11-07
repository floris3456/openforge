import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { PacerNotices } from "@opencode/core/pacer/notices"
import { PacerSessionID } from "@opencode/core/pacer/session-id"
import { Session } from "@opencode/core/session"
import type { PacerWire } from "@opencode/core/pacer/wire"
import { Pacer } from "@opencode/schema/pacer"
import { SessionID } from "@opencode/schema/session-id"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Deferred, Effect, Layer } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

// The cache notices' routes and events (spec cliproxypacer-cache-notices, section 2), through the server's own handler
// and event stream. Which rows raise a notice is tested with the notices and the connection (core's
// test/pacer/notices.test.ts and connection.test.ts).

/** A server whose notices the test holds, to give them rows as the connection does. */
const makeServer = Effect.fnUntraced(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-pacer-notices-")))
  const global = path.join(tmp.path, "global")
  yield* Effect.promise(() => fs.mkdir(global))
  const held = yield* Deferred.make<PacerNotices.Interface>()
  const handler = yield* ServerFetch.make(
    {
      database: { path: ":memory:" },
      config: { directory: global },
      fs: { filewatcher: false },
      models: { fetch: false },
    },
    {
      overrides: [
        PacerNotices.node.replace(
          makeGlobalNode({
            service: PacerNotices.Service,
            layer: Layer.effect(
              PacerNotices.Service,
              PacerNotices.make.pipe(Effect.tap((notices) => Deferred.succeed(held, notices))),
            ),
            deps: [Bus.node, Session.node],
          }),
        ),
      ],
    },
  )
  const call = (route: string, init?: RequestInit) =>
    Effect.promise(async () => {
      const response = await handler(new Request(new URL(route, "http://opencode.local"), init))
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : undefined }
    })
  // Opens one subscriber of the event stream, as a TUI does; `next` waits for the next event of a type. The stream
  // follows the bus once its first event, `server.connected`, is read.
  const subscribe = Effect.fnUntraced(function* () {
    const response = yield* Effect.promise(() => handler(new Request("http://opencode.local/api/event")))
    const reader = response.body!.getReader()
    yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel().catch(() => undefined)))
    const decoder = new TextDecoder()
    const state = { pending: "" }
    const subscriber = {
      next: (type: string) =>
        Effect.promise(async () => {
          while (true) {
            const boundary = state.pending.indexOf("\n\n")
            if (boundary !== -1) {
              const frame = state.pending.slice(0, boundary)
              state.pending = state.pending.slice(boundary + 2)
              const data = frame
                .split("\n")
                .find((line) => line.startsWith("data: "))
                ?.slice(6)
              if (!data) continue
              const event = JSON.parse(data)
              if (event.type === type) return event as { type: string; data: unknown }
              continue
            }
            const chunk = await reader.read()
            if (chunk.done) throw new Error(`the event stream closed before ${type}`)
            state.pending += decoder.decode(chunk.value, { stream: true })
          }
        }).pipe(Effect.timeout("3 seconds")),
    }
    yield* subscriber.next("server.connected")
    return subscriber
  })
  return { call, subscribe, notices: () => Deferred.await(held) }
})

/** A miss row of CPP's request list, of the chat CPP knows as `uuid`. */
const missRow = (id: number, uuid: string, at: number): PacerWire.Row => ({
  id,
  at,
  ext: `req-${id}`,
  alias: "model-a",
  kind: 0,
  status: 200,
  cache_verdict: "miss",
  cache_cause: "prefix-changed",
  changed_part: "system",
  cache_shortfall: 152_000,
  session_ext: uuid,
})

it.live("lists no notice and answers a dismissal true, with no CPP set up", () =>
  Effect.gen(function* () {
    const server = yield* makeServer()
    expect(yield* server.call("/api/experimental/pacer/notices")).toEqual({ status: 200, body: { data: [] } })
    expect(yield* server.call("/api/experimental/pacer/notices/req-1/dismiss", { method: "POST" })).toEqual({
      status: 200,
      body: { data: true },
    })
  }),
)

it.live("tells every subscriber of a new notice and of its dismissal, and lists those not dismissed", () =>
  Effect.gen(function* () {
    const server = yield* makeServer()
    const created = yield* server.call("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "A chat" }),
    })
    expect(created.status).toBe(200)
    const sessionID = SessionID.make(created.body.data.id)
    const uuid = PacerSessionID.make(sessionID)
    const notices = yield* server.notices()
    // Two TUIs at once.
    const first = yield* server.subscribe()
    const second = yield* server.subscribe()

    // CPP received both just now, after the service started.
    const now = Date.now()
    yield* notices.read(
      [missRow(1, uuid, now), missRow(2, uuid, now + 1)],
      (id) => (id === uuid ? sessionID : undefined),
      { offset: 0, now },
    )
    const expected = (id: number, at: number): Pacer.Notice => ({
      requestID: `req-${id}`,
      sessionID,
      rootID: sessionID,
      title: "A chat",
      model: "model-a",
      verdict: "miss",
      tokens: 152_000,
      cause: "prefix-changed · system",
      at,
    })
    for (const subscriber of [first, second]) {
      expect((yield* subscriber.next("pacer.notice.added")).data).toEqual({ notice: expected(1, now) })
      expect((yield* subscriber.next("pacer.notice.added")).data).toEqual({ notice: expected(2, now + 1) })
    }
    expect(yield* server.call("/api/experimental/pacer/notices")).toEqual({
      status: 200,
      body: { data: [expected(2, now + 1), expected(1, now)] },
    })

    // One TUI opens it; the dismissal reaches both.
    expect(yield* server.call("/api/experimental/pacer/notices/req-2/dismiss", { method: "POST" })).toEqual({
      status: 200,
      body: { data: true },
    })
    for (const subscriber of [first, second])
      expect((yield* subscriber.next("pacer.notice.dismissed")).data).toEqual({ requestID: "req-2" })
    expect((yield* server.call("/api/experimental/pacer/notices")).body).toEqual({ data: [expected(1, now)] })
  }),
)
